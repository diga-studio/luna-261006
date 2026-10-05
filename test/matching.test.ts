import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { maxWeightMatching, WeightedEdge } from "../src/matching.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exact maximum weight matching by exhaustive search (small n only). */
function bruteForceWeight(n: number, edges: WeightedEdge[]): number {
  const w: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const e of edges) {
    if (e.w > w[e.u][e.v]) {
      w[e.u][e.v] = e.w;
      w[e.v][e.u] = e.w;
    }
  }
  const used = new Array<boolean>(n).fill(false);
  let best = 0;
  function go(sum: number): void {
    let i = 0;
    while (i < n && used[i]) i++;
    if (i === n) {
      if (sum > best) best = sum;
      return;
    }
    used[i] = true;
    for (let j = i + 1; j < n; j++) {
      if (!used[j] && w[i][j] > 0) {
        used[j] = true;
        go(sum + w[i][j]);
        used[j] = false;
      }
    }
    go(sum); // leave i unmatched (i stays marked during the recursion)
    used[i] = false;
  }
  go(0);
  return best;
}

function totalWeight(pairs: Array<[number, number]>, edges: WeightedEdge[]): number {
  const w = new Map<string, number>();
  for (const e of edges) {
    const k = e.u < e.v ? `${e.u},${e.v}` : `${e.v},${e.u}`;
    w.set(k, Math.max(w.get(k) ?? 0, e.w));
  }
  let sum = 0;
  for (const [a, b] of pairs) {
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    sum += w.get(k) ?? 0;
  }
  return sum;
}

test("empty and trivial graphs", () => {
  deepEqual(maxWeightMatching(0, []), []);
  deepEqual(maxWeightMatching(1, []), []);
  deepEqual(maxWeightMatching(2, [{ u: 0, v: 1, w: 5 }]), [[0, 1]]);
  deepEqual(maxWeightMatching(3, []), []);
});

test("triangle picks the heaviest edge", () => {
  const pairs = maxWeightMatching(3, [
    { u: 0, v: 1, w: 1 },
    { u: 1, v: 2, w: 9 },
    { u: 0, v: 2, w: 5 },
  ]);
  deepEqual(pairs, [[1, 2]]);
});

test("blossom case: 5-cycle with a chord requires shrinking", () => {
  // Classic blossom graph where greedy fails.
  const edges: WeightedEdge[] = [
    { u: 0, v: 1, w: 10 },
    { u: 1, v: 2, w: 10 },
    { u: 2, v: 3, w: 10 },
    { u: 3, v: 4, w: 10 },
    { u: 4, v: 0, w: 10 },
    { u: 0, v: 5, w: 1 },
  ];
  const pairs = maxWeightMatching(6, edges);
  equal(pairs.length, 3);
  equal(totalWeight(pairs, edges), bruteForceWeight(6, edges));
});

test("random small graphs match brute force", () => {
  const rand = mulberry32(12345);
  for (let iter = 0; iter < 300; iter++) {
    const n = 2 + Math.floor(rand() * 9); // 2..10 vertices
    const edges: WeightedEdge[] = [];
    for (let u = 0; u < n; u++) {
      for (let v = u + 1; v < n; v++) {
        if (rand() < 0.5) {
          edges.push({ u, v, w: 1 + Math.floor(rand() * 100) });
        }
      }
    }
    const pairs = maxWeightMatching(n, edges);
    // validity: disjoint vertices, edges exist
    const seen = new Set<number>();
    for (const [a, b] of pairs) {
      ok(a !== b && !seen.has(a) && !seen.has(b), "valid matching");
      seen.add(a);
      seen.add(b);
    }
    const got = totalWeight(pairs, edges);
    const want = bruteForceWeight(n, edges);
    equal(got, want, `iter=${iter} n=${n}`);
  }
});

test("integer weights with large magnitudes stay exact", () => {
  const rand = mulberry32(999);
  for (let iter = 0; iter < 50; iter++) {
    const n = 2 + Math.floor(rand() * 8);
    const edges: WeightedEdge[] = [];
    for (let u = 0; u < n; u++) {
      for (let v = u + 1; v < n; v++) {
        if (rand() < 0.6) {
          edges.push({ u, v, w: 1 + Math.floor(rand() * 1e9) });
        }
      }
    }
    const pairs = maxWeightMatching(n, edges);
    equal(totalWeight(pairs, edges), bruteForceWeight(n, edges), `iter=${iter}`);
  }
});
