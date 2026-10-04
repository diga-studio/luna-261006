import { test } from "node:test";
import assert from "node:assert/strict";
import { BlacklistVerifier } from "../src/index.js";
import type { BlacklistEntry, VerifyResult } from "../src/index.js";

/** Deterministic PRNG (mulberry32) so tests are reproducible. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomHash(rng: () => number): string {
  const hi = Math.floor(rng() * 0x100000000);
  const lo = Math.floor(rng() * 0x100000000);
  return (
    hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0")
  );
}

/** Flips `count` distinct bit positions (0 = LSB, 63 = MSB) of a hex hash. */
function flipBits(hash: string, positions: number[]): string {
  let value = BigInt("0x" + hash);
  for (const pos of positions) {
    value ^= 1n << BigInt(pos);
  }
  return value.toString(16).padStart(16, "0");
}

function pickBitPositions(rng: () => number, count: number): number[] {
  const positions = new Set<number>();
  while (positions.size < count) {
    positions.add(Math.floor(rng() * 64));
  }
  return [...positions];
}

/** Reference brute-force verifier over an explicit id->hash map. */
function bruteForce(
  live: ReadonlyMap<number, string>,
  query: string,
): VerifyResult {
  const q = BigInt("0x" + query);
  let bestDistance = 7;
  let bestId = 0;
  for (const [id, hash] of live) {
    let x = q ^ BigInt("0x" + hash);
    let distance = 0;
    while (x !== 0n) {
      x &= x - 1n;
      distance++;
    }
    if (distance < bestDistance || (distance === bestDistance && id < bestId)) {
      bestDistance = distance;
      bestId = id;
    }
  }
  return bestDistance > 6 ? null : { evidenceId: bestId, distance: bestDistance };
}

test("exact match hits with distance 0", () => {
  const v = new BlacklistVerifier();
  v.upsert([{ evidenceId: 10, hash: "0123456789abcdef" }]);
  assert.deepEqual(v.verify(["0123456789abcdef"]), [
    { evidenceId: 10, distance: 0 },
  ]);
});

test("distance 6 hits and distance 7 misses", () => {
  const v = new BlacklistVerifier();
  const base = "3fa09c1155d28b4e";
  v.upsert([{ evidenceId: 1, hash: base }]);
  const rng = makeRng(42);
  const queries: string[] = [];
  for (let i = 0; i < 50; i++) {
    queries.push(flipBits(base, pickBitPositions(rng, 6)));
    queries.push(flipBits(base, pickBitPositions(rng, 7)));
  }
  const results = v.verify(queries);
  for (let i = 0; i < queries.length; i++) {
    if (i % 2 === 0) {
      assert.deepEqual(results[i], { evidenceId: 1, distance: 6 }, queries[i]);
    } else {
      assert.equal(results[i], null, queries[i]);
    }
  }
});

test("most significant bit participates in distance", () => {
  const v = new BlacklistVerifier();
  v.upsert([{ evidenceId: 7, hash: "0000000000000000" }]);
  // Only bit 63 flipped: distance 1, must hit.
  assert.deepEqual(v.verify(["8000000000000000"]), [
    { evidenceId: 7, distance: 1 },
  ]);
  // Bits 59..63 flipped plus two low bits: distance 7, must miss.
  assert.equal(v.verify(["f800000000000003"])[0], null);
  // Bit 63 plus five low bits: distance 6, must hit.
  assert.deepEqual(v.verify(["800000000000001f"]), [
    { evidenceId: 7, distance: 6 },
  ]);
});

test("smallest distance wins, ties broken by smallest evidence id", () => {
  const v = new BlacklistVerifier();
  // Small id but far away, larger id but nearest.
  v.upsert([
    { evidenceId: 1, hash: flipBits("00".repeat(8), [10, 11, 12, 13]) },
    { evidenceId: 2, hash: flipBits("00".repeat(8), [20, 21]) },
    { evidenceId: 3, hash: flipBits("00".repeat(8), [30, 31]) },
  ]);
  assert.deepEqual(v.verify(["0000000000000000"]), [
    { evidenceId: 2, distance: 2 },
  ]);

  // Equal distances: smallest id must win even if inserted later.
  const tied = new BlacklistVerifier();
  tied.upsert([
    { evidenceId: 9, hash: flipBits("00".repeat(8), [5]) },
    { evidenceId: 4, hash: flipBits("00".repeat(8), [6]) },
    { evidenceId: 12, hash: flipBits("00".repeat(8), [7]) },
  ]);
  assert.deepEqual(tied.verify(["0000000000000000"]), [
    { evidenceId: 4, distance: 1 },
  ]);
});

test("upsert with existing id replaces the old hash", () => {
  const v = new BlacklistVerifier();
  v.upsert([{ evidenceId: 3, hash: "0000000000000000" }]);
  v.upsert([{ evidenceId: 3, hash: "ffffffffffffffff" }]);
  assert.equal(v.size, 1);
  assert.equal(v.verify(["0000000000000000"])[0], null);
  assert.deepEqual(v.verify(["ffffffffffffffff"])[0], {
    evidenceId: 3,
    distance: 0,
  });
});

test("duplicate ids within one batch: last entry wins", () => {
  const v = new BlacklistVerifier();
  v.upsert([
    { evidenceId: 3, hash: "0000000000000000" },
    { evidenceId: 3, hash: "ffffffffffffffff" },
  ]);
  assert.equal(v.size, 1);
  assert.equal(v.verify(["0000000000000000"])[0], null);
  assert.deepEqual(v.verify(["ffffffffffffffff"])[0], {
    evidenceId: 3,
    distance: 0,
  });
});

test("removing one id does not affect other ids sharing the same hash", () => {
  const v = new BlacklistVerifier();
  v.upsert([
    { evidenceId: 1, hash: "aaaaaaaaaaaaaaaa" },
    { evidenceId: 2, hash: "aaaaaaaaaaaaaaaa" },
    { evidenceId: 3, hash: "aaaaaaaaaaaaaaaa" },
  ]);
  v.remove([1]);
  assert.deepEqual(v.verify(["aaaaaaaaaaaaaaaa"])[0], {
    evidenceId: 2,
    distance: 0,
  });
  v.remove([2, 3]);
  assert.equal(v.verify(["aaaaaaaaaaaaaaaa"])[0], null);
  assert.equal(v.size, 0);
});

test("repeated removal of the same id is a no-op", () => {
  const v = new BlacklistVerifier();
  v.upsert([
    { evidenceId: 1, hash: "1111111111111111" },
    { evidenceId: 2, hash: "1111111111111111" },
  ]);
  v.remove([1]);
  v.remove([1]);
  v.remove([1, 999]);
  assert.equal(v.size, 1);
  assert.deepEqual(v.verify(["1111111111111111"])[0], {
    evidenceId: 2,
    distance: 0,
  });
});

test("after removing the best evidence the next best is returned", () => {
  const v = new BlacklistVerifier();
  v.upsert([
    { evidenceId: 5, hash: "0000000000000000" },
    { evidenceId: 6, hash: "0000000000000003" },
    { evidenceId: 7, hash: "ffffffffffffffff" },
  ]);
  assert.deepEqual(v.verify(["0000000000000000"])[0], {
    evidenceId: 5,
    distance: 0,
  });
  v.remove([5]);
  assert.deepEqual(v.verify(["0000000000000000"])[0], {
    evidenceId: 6,
    distance: 2,
  });
  v.remove([6]);
  assert.equal(v.verify(["0000000000000000"])[0], null);
});

test("verify returns one result per query in input order", () => {
  const v = new BlacklistVerifier();
  v.upsert([{ evidenceId: 1, hash: "abcdef0123456789" }]);
  const results = v.verify([
    "abcdef0123456789",
    "0000000000000000",
    "abcdef0123456789",
  ]);
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], { evidenceId: 1, distance: 0 });
  assert.equal(results[1], null);
  assert.deepEqual(results[2], { evidenceId: 1, distance: 0 });
});

test("invalid input is rejected", () => {
  const v = new BlacklistVerifier();
  assert.throws(() =>
    v.upsert([{ evidenceId: 0, hash: "0000000000000000" }]),
  );
  assert.throws(() =>
    v.upsert([{ evidenceId: -3, hash: "0000000000000000" }]),
  );
  assert.throws(() =>
    v.upsert([{ evidenceId: 1.5, hash: "0000000000000000" }]),
  );
  assert.throws(() => v.upsert([{ evidenceId: 1, hash: "xyz" }]));
  assert.throws(() => v.upsert([{ evidenceId: 1, hash: "00000000000000000" }]));
  assert.throws(() => v.verify(["not-a-hash"]));
});

test("randomized cross-check against brute force, including mutations", () => {
  const rng = makeRng(20261006);
  const v = new BlacklistVerifier();
  const live = new Map<number, string>();

  const applyUpserts = (entries: BlacklistEntry[]) => {
    v.upsert(entries);
    for (const e of entries) {
      live.set(e.evidenceId, e.hash);
    }
  };
  const applyRemovals = (ids: number[]) => {
    v.remove(ids);
    for (const id of ids) {
      live.delete(id);
    }
  };
  const checkQueries = (queries: string[]) => {
    const actual = v.verify(queries);
    for (let i = 0; i < queries.length; i++) {
      assert.deepEqual(
        actual[i],
        bruteForce(live, queries[i]!),
        `query ${queries[i]}`,
      );
    }
  };

  // Initial load: 3000 random records, some sharing hashes.
  const initial: BlacklistEntry[] = [];
  for (let id = 1; id <= 3000; id++) {
    initial.push({ evidenceId: id, hash: randomHash(rng) });
  }
  const shared = randomHash(rng);
  for (let id = 3001; id <= 3010; id++) {
    initial.push({ evidenceId: id, hash: shared });
  }
  applyUpserts(initial);

  // Queries: random (mostly misses) plus controlled-distance probes.
  const queries: string[] = [];
  const liveHashes = [...live.values()];
  for (let i = 0; i < 400; i++) {
    queries.push(randomHash(rng));
  }
  for (let i = 0; i < 400; i++) {
    const base = liveHashes[Math.floor(rng() * liveHashes.length)]!;
    const distance = 1 + Math.floor(rng() * 8);
    queries.push(flipBits(base, pickBitPositions(rng, distance)));
  }
  checkQueries(queries);

  // Replace a third of the records (new random hashes), remove a third,
  // then re-verify a fresh batch against the mutated live set.
  const replacements: BlacklistEntry[] = [];
  for (let id = 1; id <= 1000; id++) {
    replacements.push({ evidenceId: id, hash: randomHash(rng) });
  }
  applyUpserts(replacements);
  const removals: number[] = [];
  for (let id = 1001; id <= 2000; id++) {
    removals.push(id);
  }
  // Remove all but one of the shared-hash ids, plus unknown ids.
  removals.push(3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009);
  removals.push(999991, 999992);
  applyRemovals(removals);
  applyRemovals(removals); // repeated removal must not change anything
  assert.equal(v.size, live.size);

  const queries2: string[] = [];
  const liveHashes2 = [...live.values()];
  for (let i = 0; i < 400; i++) {
    queries2.push(randomHash(rng));
  }
  for (let i = 0; i < 400; i++) {
    const base = liveHashes2[Math.floor(rng() * liveHashes2.length)]!;
    const distance = 1 + Math.floor(rng() * 8);
    queries2.push(flipBits(base, pickBitPositions(rng, distance)));
  }
  // Old hashes of replaced/removed ids must not be reachable anymore.
  for (const e of replacements.slice(0, 50)) {
    queries2.push(e.hash);
  }
  checkQueries(queries2);

  // Delete the last shared-hash id as well.
  applyRemovals([3010]);
  assert.equal(v.verify([shared])[0], bruteForce(live, shared));
});
