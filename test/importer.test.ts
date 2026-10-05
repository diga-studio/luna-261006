import { test } from "node:test";
import assert from "node:assert/strict";
import { createImporter, MAX_DISTANCE, type ExistingRecord, type ImportRowResult } from "../src/importer.js";
import { levenshtein, levenshteinWithin } from "../src/levenshtein.js";

// ---------------------------------------------------------------------------
// Independent naive reference implementation (full DP matrix, no banding).
// ---------------------------------------------------------------------------

function naiveLevenshtein(a: string, b: string): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    d[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    d[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[a.length][b.length];
}

class NaiveImporter {
  private records: ExistingRecord[];
  private maxId: number;

  constructor(existing: ExistingRecord[]) {
    this.records = existing.map((r) => ({ ...r }));
    this.maxId = existing.reduce((m, r) => Math.max(m, r.id), 0);
  }

  importBatch(names: string[]): ImportRowResult[] {
    const results: ImportRowResult[] = [];
    for (const name of names) {
      let bestId = -1;
      let bestDistance = MAX_DISTANCE + 1;
      for (const record of this.records) {
        const distance = naiveLevenshtein(name, record.name);
        if (distance > MAX_DISTANCE) {
          continue;
        }
        if (distance < bestDistance || (distance === bestDistance && record.id < bestId)) {
          bestDistance = distance;
          bestId = record.id;
        }
      }
      if (bestId >= 0) {
        results.push({ kind: "duplicate", name, matchedId: bestId, distance: bestDistance });
      } else {
        this.maxId += 1;
        this.records.push({ id: this.maxId, name });
        results.push({ kind: "added", id: this.maxId, name });
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) and random name/batch generators.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = "aabbc"; // repeated chars on purpose

function randomName(rand: () => number): string {
  const length = 1 + Math.floor(rand() * 8);
  let name = "";
  for (let i = 0; i < length; i++) {
    name += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return name;
}

// Apply random insert/delete/substitute/duplicate-char edits so that batches
// contain plenty of near-duplicates of existing names.
function mutateName(rand: () => number, name: string): string {
  let result = name;
  const edits = Math.floor(rand() * 5);
  for (let e = 0; e < edits && result.length > 0; e++) {
    const pos = Math.floor(rand() * result.length);
    const ch = ALPHABET[Math.floor(rand() * ALPHABET.length)];
    switch (Math.floor(rand() * 4)) {
      case 0: // insert
        result = result.slice(0, pos) + ch + result.slice(pos);
        break;
      case 1: // delete
        result = result.slice(0, pos) + result.slice(pos + 1);
        break;
      case 2: // substitute
        result = result.slice(0, pos) + ch + result.slice(pos + 1);
        break;
      default: // duplicate the char at pos
        result = result.slice(0, pos + 1) + result[pos] + result.slice(pos + 1);
        break;
    }
  }
  return result.length > 0 ? result : "a";
}

function randomBatch(rand: () => number, pool: string[]): string[] {
  const size = 1 + Math.floor(rand() * 12);
  const batch: string[] = [];
  for (let i = 0; i < size; i++) {
    const roll = rand();
    if (roll < 0.45 && pool.length > 0) {
      // mutate a known name: likely within distance 3
      batch.push(mutateName(rand, pool[Math.floor(rand() * pool.length)]));
    } else if (roll < 0.6 && pool.length > 0) {
      // exact duplicate
      batch.push(pool[Math.floor(rand() * pool.length)]);
    } else {
      batch.push(randomName(rand));
    }
  }
  return batch;
}

// ---------------------------------------------------------------------------
// Levenshtein primitives
// ---------------------------------------------------------------------------

test("levenshtein matches naive implementation on random strings", () => {
  const rand = mulberry32(12345);
  for (let i = 0; i < 2000; i++) {
    const a = randomName(rand);
    const b = randomName(rand);
    assert.equal(levenshtein(a, b), naiveLevenshtein(a, b), `levenshtein(${a}, ${b})`);
    for (let bound = 0; bound <= 5; bound++) {
      const within = levenshteinWithin(a, b, bound);
      const exact = naiveLevenshtein(a, b);
      if (exact <= bound) {
        assert.equal(within, exact, `levenshteinWithin(${a}, ${b}, ${bound})`);
      } else {
        assert.ok(within > bound, `levenshteinWithin(${a}, ${b}, ${bound}) should exceed bound`);
      }
    }
  }
});

test("levenshtein unit costs: insert, delete, substitute; no transposition", () => {
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("abc", "abcd"), 1); // insert
  assert.equal(levenshtein("abcd", "abc"), 1); // delete
  assert.equal(levenshtein("abc", "axc"), 1); // substitute
  assert.equal(levenshtein("ab", "ba"), 2); // transposition is NOT one op
  assert.equal(levenshtein("aaaa", "aaaa"), 0); // repeated chars
  assert.equal(levenshtein("aaaa", "aa"), 2);
});

// ---------------------------------------------------------------------------
// Importer basics
// ---------------------------------------------------------------------------

test("empty library assigns ids starting from 1", () => {
  const importer = createImporter([]);
  assert.deepEqual(importer.importBatch(["alice", "bob"]), [
    { kind: "added", id: 1, name: "alice" },
    { kind: "added", id: 2, name: "bob" },
  ]);
});

test("new ids continue from current maximum id", () => {
  const importer = createImporter([
    { id: 3, name: "alice" },
    { id: 7, name: "bob" },
  ]);
  assert.deepEqual(importer.importBatch(["carol"]), [{ kind: "added", id: 8, name: "carol" }]);
});

test("exact duplicate is skipped and reports distance 0", () => {
  const importer = createImporter([{ id: 5, name: "alice" }]);
  assert.deepEqual(importer.importBatch(["alice"]), [
    { kind: "duplicate", name: "alice", matchedId: 5, distance: 0 },
  ]);
});

test("tie on distance picks the smallest id", () => {
  const importer = createImporter([
    { id: 9, name: "abc" },
    { id: 2, name: "abd" },
    { id: 4, name: "abe" },
  ]);
  // "abf" is distance 1 from all three records; smallest id wins.
  assert.deepEqual(importer.importBatch(["abf"]), [
    { kind: "duplicate", name: "abf", matchedId: 2, distance: 1 },
  ]);
});

test("added records persist across importBatch calls", () => {
  const importer = createImporter([]);
  importer.importBatch(["alice"]);
  assert.deepEqual(importer.importBatch(["alicf"]), [
    { kind: "duplicate", name: "alicf", matchedId: 1, distance: 1 },
  ]);
});

test("rejects invalid or duplicate existing ids", () => {
  assert.throws(() => createImporter([{ id: 0, name: "a" }]));
  assert.throws(() => createImporter([{ id: 1.5, name: "a" }]));
  assert.throws(() =>
    createImporter([
      { id: 1, name: "a" },
      { id: 1, name: "b" },
    ]),
  );
});

// ---------------------------------------------------------------------------
// Non-transitivity: skipped rows must not become a basis for later rows.
// ---------------------------------------------------------------------------

test("chain: skipping B does not make C a duplicate of A", () => {
  // d(A, B) = 3 <= 3, d(B, C) = 3 <= 3, but d(A, C) = 6 > 3.
  const A = "aaaaaa";
  const B = "aaabbb";
  const C = "bbbbbb";
  assert.equal(naiveLevenshtein(A, B), 3);
  assert.equal(naiveLevenshtein(B, C), 3);
  assert.ok(naiveLevenshtein(A, C) > MAX_DISTANCE);

  const importer = createImporter([{ id: 1, name: A }]);
  const results = importer.importBatch([B, C]);
  assert.deepEqual(results, [
    { kind: "duplicate", name: B, matchedId: 1, distance: 3 },
    // C is within distance 3 of the skipped B, but B never entered the
    // library, so C must be added.
    { kind: "added", id: 2, name: C },
  ]);
});

// ---------------------------------------------------------------------------
// Randomized cross-check against the naive reference importer.
// ---------------------------------------------------------------------------

test("randomized batches match naive reference row by row", () => {
  for (const seed of [1, 7, 42, 1337, 20261005]) {
    const rand = mulberry32(seed);

    // Random small existing library; duplicate names allowed, ids distinct.
    const existing: ExistingRecord[] = [];
    const libSize = Math.floor(rand() * 8);
    for (let i = 0; i < libSize; i++) {
      existing.push({ id: i + 1, name: randomName(rand) });
    }

    const importer = createImporter(existing);
    const naive = new NaiveImporter(existing);

    // Pool of names used to breed near-duplicates; starts from the library
    // and grows with everything we feed in (added or skipped).
    const pool = existing.map((r) => r.name);

    for (let batch = 0; batch < 20; batch++) {
      const names = randomBatch(rand, pool);
      const expected = naive.importBatch(names);
      const actual = importer.importBatch(names);
      assert.deepEqual(
        actual,
        expected,
        `seed=${seed} batch=${batch} names=${JSON.stringify(names)}`,
      );
      pool.push(...names);
    }
  }
});
