import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createImporter,
  MAX_DISTANCE,
  type ExistingRecord,
  type ImportRowResult,
} from "../src/index.js";

/** Independent naive reference: full-matrix edit distance, written from the definition. */
function naiveDistance(a: string, b: string): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d.push([i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
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

/** Naive in-test simulation of the spec, used as the differential oracle. */
class NaiveImporter {
  private records: ExistingRecord[];
  private maxId: number;

  constructor(existing: ExistingRecord[]) {
    this.records = existing.map((r) => ({ ...r }));
    this.maxId = this.records.reduce((m, r) => Math.max(m, r.id), 0);
  }

  importBatch(names: string[]): ImportRowResult[] {
    return names.map((name) => {
      let bestId = -1;
      let bestDistance = Infinity;
      for (const record of this.records) {
        const distance = naiveDistance(name, record.name);
        if (distance < bestDistance || (distance === bestDistance && record.id < bestId)) {
          bestDistance = distance;
          bestId = record.id;
        }
      }
      if (bestDistance <= MAX_DISTANCE) {
        return { kind: "duplicate", id: bestId, name, distance: bestDistance };
      }
      this.maxId += 1;
      this.records.push({ id: this.maxId, name });
      return { kind: "inserted", id: this.maxId, name };
    });
  }
}

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

test("empty library: ids start at 1 and increment", () => {
  const importer = createImporter([]);
  assert.deepEqual(importer.importBatch(["ann", "zzzzqqqq", "ann"]), [
    { kind: "inserted", id: 1, name: "ann" },
    { kind: "inserted", id: 2, name: "zzzzqqqq" },
    { kind: "duplicate", id: 1, name: "ann", distance: 0 },
  ]);
});

test("new ids continue from current maximum id", () => {
  const importer = createImporter([
    { id: 7, name: "alpha" },
    { id: 3, name: "beta" },
  ]);
  const [result] = importer.importBatch(["gamma-ray"]);
  assert.deepEqual(result, { kind: "inserted", id: 8, name: "gamma-ray" });
});

test("distance ties resolve to the smallest id", () => {
  const importer = createImporter([
    { id: 9, name: "abcx" },
    { id: 4, name: "abcy" },
  ]);
  const [result] = importer.importBatch(["abcz"]);
  assert.deepEqual(result, { kind: "duplicate", id: 4, name: "abcz", distance: 1 });
});

test("boundary: distance exactly 3 is a duplicate, 4 is not", () => {
  const importer = createImporter([{ id: 1, name: "aaaa" }]);
  assert.deepEqual(importer.importBatch(["abbb"]), [
    { kind: "duplicate", id: 1, name: "abbb", distance: 3 },
  ]);
  assert.deepEqual(importer.importBatch(["bbbb"]), [
    { kind: "inserted", id: 2, name: "bbbb" },
  ]);
});

test("input names are never mutated", () => {
  const importer = createImporter([{ id: 1, name: "  Mixed Case " }]);
  const odd = "  Mixed Case ";
  const [result] = importer.importBatch([odd]);
  assert.deepEqual(result, { kind: "duplicate", id: 1, name: odd, distance: 0 });
  assert.equal(odd, "  Mixed Case ");
});

test("chain: skipped row is not a dedup basis for later rows", () => {
  // d(甲,乙)=3, d(乙,丙)=3, but d(甲,丙)=6 > 3.
  const importer = createImporter([{ id: 1, name: "aaaaaa" }]);
  const results = importer.importBatch(["aaabbb", "bbbbbb"]);
  assert.deepEqual(results, [
    { kind: "duplicate", id: 1, name: "aaabbb", distance: 3 },
    { kind: "inserted", id: 2, name: "bbbbbb" },
  ]);
});

test("rows see earlier inserts of the same batch, across batches too", () => {
  const importer = createImporter([]);
  const first = importer.importBatch(["hello", "hello!"]); // "hello!" dup of fresh "hello"
  assert.deepEqual(first, [
    { kind: "inserted", id: 1, name: "hello" },
    { kind: "duplicate", id: 1, name: "hello!", distance: 1 },
  ]);
  const second = importer.importBatch(["hello?"]);
  assert.deepEqual(second, [{ kind: "duplicate", id: 1, name: "hello?", distance: 1 }]);
});

test("seeded random libraries and batches match naive row-by-row oracle", () => {
  const rand = mulberry32(71006);
  const alphabet = "aabbc"; // repeated chars keep distances small and hits frequent
  const randomName = (): string => {
    const len = 1 + Math.floor(rand() * 6);
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
    return s;
  };

  for (let trial = 0; trial < 200; trial++) {
    const existing: ExistingRecord[] = [];
    const libSize = Math.floor(rand() * 9);
    const usedIds = new Set<number>();
    for (let i = 0; i < libSize; i++) {
      let id = 1 + Math.floor(rand() * 1000);
      while (usedIds.has(id)) id += 1;
      usedIds.add(id);
      existing.push({ id, name: randomName() });
    }

    const actual = createImporter(existing);
    const oracle = new NaiveImporter(existing);

    for (let batch = 0; batch < 5; batch++) {
      const names: string[] = [];
      const batchSize = 1 + Math.floor(rand() * 10);
      for (let i = 0; i < batchSize; i++) names.push(randomName());
      assert.deepEqual(actual.importBatch(names), oracle.importBatch(names));
    }
  }
});
