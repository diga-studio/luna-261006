import { test } from "node:test";
import * as assert from "node:assert/strict";
import { maxWeightMatching } from "../src/matching";

/** Brute-force max-cardinality, then max-weight matching for small n. */
function bruteForce(n: number, edges: Array<[number, number, number]>): number {
  const adj: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  for (const [v, w, wt] of edges) {
    if (v === w) continue;
    adj[v]!.push([w, wt]);
    adj[w]!.push([v, wt]);
  }
  let bestCount = -1;
  let bestWeight = -1;
  const used = new Array<boolean>(n).fill(false);
  function go(v: number, count: number, weight: number): void {
    while (v < n && used[v]!) v++;
    if (v === n) {
      if (count > bestCount || (count === bestCount && weight > bestWeight)) {
        bestCount = count;
        bestWeight = weight;
      }
      return;
    }
    // Option 1: leave v unmatched.
    go(v + 1, count, weight);
    // Option 2: match v with a free neighbor.
    used[v] = true;
    for (const [w, wt] of adj[v]!) {
      if (!used[w]!) {
        used[w] = true;
        go(v + 1, count + 1, weight + wt);
        used[w] = false;
      }
    }
    used[v] = false;
  }
  go(0, 0, 0);
  return bestWeight;
}

function flat(edges: Array<[number, number, number]>): number[] {
  const out: number[] = [];
  for (const [v, w, wt] of edges) out.push(v, w, wt);
  return out;
}

function matchingWeight(
  n: number,
  edges: Array<[number, number, number]>,
  mate: Int32Array,
): number {
  let weight = 0;
  const seen = new Set<number>();
  for (let v = 0; v < n; v++) {
    const w = mate[v]!;
    if (w === -1) continue;
    assert.ok(w >= 0 && w < n, "mate in range");
    assert.strictEqual(mate[w], v, "mate symmetric");
    if (seen.has(v)) continue;
    assert.ok(!seen.has(w), "no vertex matched twice");
    seen.add(v);
    seen.add(w);
    const edge = edges.find(
      ([a, b]) => (a === v && b === w) || (a === w && b === v),
    );
    assert.ok(edge, "matched edge exists");
    weight += edge[2];
  }
  return weight;
}

// Deterministic PRNG (mulberry32).
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("blossom matching matches brute force on random small graphs", () => {
  const rand = rng(12345);
  for (let iter = 0; iter < 300; iter++) {
    const n = 2 + Math.floor(rand() * 9); // 2..10 vertices
    const edges: Array<[number, number, number]> = [];
    for (let v = 0; v < n; v++) {
      for (let w = v + 1; w < n; w++) {
        if (rand() < 0.5) {
          edges.push([v, w, 1 + Math.floor(rand() * 20)]);
        }
      }
    }
    const mate = maxWeightMatching(n, flat(edges));
    const got = matchingWeight(n, edges, mate);
    const want = bruteForce(n, edges);
    assert.strictEqual(got, want, `iteration ${iter}, n=${n}`);
  }
});

test("empty and trivial graphs", () => {
  assert.deepStrictEqual([...maxWeightMatching(0, [])], []);
  assert.deepStrictEqual([...maxWeightMatching(3, [])], [-1, -1, -1]);
  assert.deepStrictEqual([...maxWeightMatching(2, [0, 1, 5])], [1, 0]);
});

test("odd cycle requires blossom contraction", () => {
  // Triangle plus a tail; max cardinality matching has size 2.
  const edges: Array<[number, number, number]> = [
    [0, 1, 10],
    [1, 2, 10],
    [0, 2, 10],
    [2, 3, 1],
  ];
  const mate = maxWeightMatching(4, flat(edges));
  const matched = [...mate].filter((x) => x !== -1).length;
  assert.strictEqual(matched, 4);
});
