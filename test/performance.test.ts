import { test } from "node:test";
import assert from "node:assert/strict";
import { BlacklistVerifier } from "../src/index.js";

const RECORD_COUNT = 1_000_000;
const QUERY_COUNT = 10_000;
const EXACT_HIT_QUERIES = 1_000;
const MISS_QUERIES = 1_000;
const UPSERT_CHUNK = 100_000;
const VERIFY_TIME_LIMIT_MS = 10_000;
const MEMORY_LIMIT_BYTES = 768 * 1024 * 1024;
const BRUTE_FORCE_HIT_SAMPLE = 200;

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

function toHex(hi: number, lo: number): string {
  return (
    (hi >>> 0).toString(16).padStart(8, "0") +
    (lo >>> 0).toString(16).padStart(8, "0")
  );
}

function popcount32(x: number): number {
  let v = x >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

interface GeneratedBlacklist {
  verifier: BlacklistVerifier;
  hi: Uint32Array;
  lo: Uint32Array;
}

/**
 * Builds a verifier with RECORD_COUNT records. When `sharedHigh16` is set,
 * every record (and later every query) uses that high 16-bit prefix while
 * the remaining 48 bits stay random. Hashes are guaranteed unique.
 */
function buildBlacklist(
  seed: number,
  sharedHigh16: number | null,
): GeneratedBlacklist {
  const rng = makeRng(seed);
  const verifier = new BlacklistVerifier();
  const hi = new Uint32Array(RECORD_COUNT);
  const lo = new Uint32Array(RECORD_COUNT);
  const seen = new Set<number>();

  let produced = 0;
  while (produced < RECORD_COUNT) {
    const entries: Array<{ evidenceId: number; hash: string }> = [];
    const target = Math.min(produced + UPSERT_CHUNK, RECORD_COUNT);
    while (produced < target) {
      const hiPart =
        sharedHigh16 === null
          ? Math.floor(rng() * 0x100000000)
          : ((sharedHigh16 << 16) | Math.floor(rng() * 0x10000)) >>> 0;
      const loPart = Math.floor(rng() * 0x100000000);
      const dedupKey = hiPart * 0x100000000 + loPart;
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);
      hi[produced] = hiPart;
      lo[produced] = loPart;
      entries.push({ evidenceId: produced + 1, hash: toHex(hiPart, loPart) });
      produced++;
    }
    verifier.upsert(entries);
  }
  return { verifier, hi, lo };
}

interface QueryPlan {
  queries: string[];
  /** Per query: "exact" (distance 0 to a known id), "near" (distance 1..6
   * to a known record), or "miss" (brute-force confirmed no hit). */
  kinds: Array<"exact" | "near" | "miss">;
  /** For "exact": the evidence id that must be returned. */
  exactIds: number[];
  /** For "near": the constructed distance upper bound. */
  nearBounds: number[];
}

function flipRandomBits(
  rng: () => number,
  hi: number,
  lo: number,
  count: number,
): { hi: number; lo: number } {
  const positions = new Set<number>();
  while (positions.size < count) {
    positions.add(Math.floor(rng() * 64));
  }
  let newHi = hi >>> 0;
  let newLo = lo >>> 0;
  for (const pos of positions) {
    if (pos >= 32) {
      newHi = (newHi ^ (1 << (pos - 32))) >>> 0;
    } else {
      newLo = (newLo ^ (1 << pos)) >>> 0;
    }
  }
  return { hi: newHi, lo: newLo };
}

/** Exact brute-force best match over the raw hash arrays. */
function bruteForceBest(
  hi: Uint32Array,
  lo: Uint32Array,
  queryHi: number,
  queryLo: number,
): { evidenceId: number; distance: number } | null {
  let bestDistance = 7;
  let bestId = 0;
  for (let i = 0; i < hi.length; i++) {
    const distance =
      popcount32(queryHi ^ hi[i]!) + popcount32(queryLo ^ lo[i]!);
    const id = i + 1;
    if (
      distance < bestDistance ||
      (distance === bestDistance && id < bestId)
    ) {
      bestDistance = distance;
      bestId = id;
    }
  }
  return bestDistance > 6 ? null : { evidenceId: bestId, distance: bestDistance };
}

/** True iff no record is within distance 6 (early-exit exact scan). */
function bruteForceIsMiss(
  hi: Uint32Array,
  lo: Uint32Array,
  queryHi: number,
  queryLo: number,
): boolean {
  for (let i = 0; i < hi.length; i++) {
    const hiDistance = popcount32(queryHi ^ hi[i]!);
    if (hiDistance <= 6 && hiDistance + popcount32(queryLo ^ lo[i]!) <= 6) {
      return false;
    }
  }
  return true;
}

function buildQueryPlan(
  seed: number,
  data: GeneratedBlacklist,
  sharedHigh16: number | null,
): QueryPlan {
  const rng = makeRng(seed);
  const { hi, lo } = data;
  const queries: string[] = [];
  const kinds: QueryPlan["kinds"] = [];
  const exactIds: number[] = [];
  const nearBounds: number[] = [];

  const nearCount = QUERY_COUNT - EXACT_HIT_QUERIES - MISS_QUERIES;
  for (let i = 0; i < EXACT_HIT_QUERIES + nearCount; i++) {
    const index = Math.floor(rng() * RECORD_COUNT);
    const isExact = i < EXACT_HIT_QUERIES;
    const flips = isExact ? 0 : 1 + Math.floor(rng() * 6);
    const flipped = flipRandomBits(rng, hi[index]!, lo[index]!, flips);
    queries.push(toHex(flipped.hi, flipped.lo));
    kinds.push(isExact ? "exact" : "near");
    exactIds.push(index + 1);
    nearBounds.push(flips);
  }

  // Miss candidates are brute-force confirmed against all one million
  // records; any accidental hit is regenerated.
  let misses = 0;
  while (misses < MISS_QUERIES) {
    const hiPart =
      sharedHigh16 === null
        ? Math.floor(rng() * 0x100000000)
        : ((sharedHigh16 << 16) | Math.floor(rng() * 0x10000)) >>> 0;
    const loPart = Math.floor(rng() * 0x100000000);
    if (!bruteForceIsMiss(hi, lo, hiPart, loPart)) {
      continue;
    }
    queries.push(toHex(hiPart, loPart));
    kinds.push("miss");
    exactIds.push(0);
    nearBounds.push(0);
    misses++;
  }

  return { queries, kinds, exactIds, nearBounds };
}

function rssBytes(): number {
  return process.memoryUsage().rss;
}

function runDistributionScenario(
  name: string,
  seed: number,
  sharedHigh16: number | null,
): void {
  const data = buildBlacklist(seed, sharedHigh16);
  assert.equal(data.verifier.size, RECORD_COUNT);
  const rssAfterLoad = rssBytes();

  const plan = buildQueryPlan(seed ^ 0x9e3779b9, data, sharedHigh16);
  assert.equal(plan.queries.length, QUERY_COUNT);
  const rssBeforeVerify = rssBytes();

  const started = performance.now();
  const results = data.verifier.verify(plan.queries);
  const elapsedMs = performance.now() - started;
  const rssAfterVerify = rssBytes();

  const peakRss = Math.max(rssAfterLoad, rssBeforeVerify, rssAfterVerify);
  console.log(
    `    [${name}] verify ${QUERY_COUNT} queries over ${RECORD_COUNT} records: ` +
      `${elapsedMs.toFixed(0)} ms, peak rss ${(peakRss / 1024 / 1024).toFixed(0)} MiB`,
  );

  assert.ok(
    elapsedMs < VERIFY_TIME_LIMIT_MS,
    `verification took ${elapsedMs.toFixed(0)} ms, limit ${VERIFY_TIME_LIMIT_MS} ms`,
  );
  assert.ok(
    peakRss < MEMORY_LIMIT_BYTES,
    `peak rss ${(peakRss / 1024 / 1024).toFixed(0)} MiB exceeds 768 MiB`,
  );

  // Known hits and misses by construction.
  let hitCount = 0;
  let missCount = 0;
  for (let i = 0; i < QUERY_COUNT; i++) {
    const result = results[i]!;
    const kind = plan.kinds[i]!;
    if (kind === "miss") {
      assert.equal(result, null, `query ${i} must miss`);
      missCount++;
    } else if (kind === "exact") {
      assert.deepEqual(result, {
        evidenceId: plan.exactIds[i]!,
        distance: 0,
      });
      hitCount++;
    } else {
      assert.ok(result !== null, `query ${i} must hit`);
      assert.ok(
        result.distance <= plan.nearBounds[i]!,
        `query ${i} distance ${result.distance} exceeds constructed bound`,
      );
      hitCount++;
    }
  }
  assert.equal(hitCount, QUERY_COUNT - MISS_QUERIES);
  assert.equal(missCount, MISS_QUERIES);

  // Exact brute-force cross-check on a sample of hit queries.
  const rng = makeRng(seed ^ 0x51ab3f);
  for (let s = 0; s < BRUTE_FORCE_HIT_SAMPLE; s++) {
    const index = Math.floor(rng() * QUERY_COUNT);
    const query = plan.queries[index]!;
    const queryHi = parseInt(query.slice(0, 8), 16);
    const queryLo = parseInt(query.slice(8), 16);
    const expected = bruteForceBest(data.hi, data.lo, queryHi, queryLo);
    assert.deepEqual(results[index], expected, `query ${index}`);
  }
}

test("performance: 1M records, 10k queries, fully random hashes", () => {
  runDistributionScenario("random", 1234567, null);
});

test("performance: 1M records, 10k queries, shared high 16 bits", () => {
  runDistributionScenario("shared-high-16", 7654321, 0xb1ac);
});
