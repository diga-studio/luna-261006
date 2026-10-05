import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph, type Batch, type Ref } from '../src/index.ts';
import {
  assertSameSnapshot,
  assertValidSnapshot,
  assertValidWitness,
  pairKey,
  refSetOf,
} from './helpers.ts';

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

/** Naive oracle: does the given ref set contain a dependency cycle? */
function hasCycle(ids: string[], refs: Set<string>): boolean {
  const succ = new Map<string, string[]>();
  for (const id of ids) succ.set(id, []);
  for (const key of refs) {
    const [from, to] = key.split('|') as [string, string];
    succ.get(from)!.push(to);
  }
  const state = new Map<string, number>(); // 0=unvisited 1=in-stack 2=done
  const visit = (start: string): boolean => {
    const stack: Array<[string, number]> = [[start, 0]];
    state.set(start, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const [node, nextIdx] = top;
      const edges = succ.get(node)!;
      if (nextIdx < edges.length) {
        top[1] = nextIdx + 1;
        const next = edges[nextIdx]!;
        const s = state.get(next) ?? 0;
        if (s === 1) return true;
        if (s === 0) {
          state.set(next, 1);
          stack.push([next, 0]);
        }
      } else {
        state.set(node, 2);
        stack.pop();
      }
    }
    return false;
  };
  for (const id of ids) {
    if ((state.get(id) ?? 0) === 0 && visit(id)) return true;
  }
  return false;
}

test('randomized differential test against naive oracle', () => {
  const rand = mulberry32(0x5eed);
  const N = 30;
  const ids = Array.from({ length: N }, (_, i) => `r${i}`);

  // Initial DAG: random permutation, forward edges with some probability.
  const perm = [...ids];
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }
  const posOf = new Map(perm.map((id, i) => [id, i]));
  const refs = new Set<string>();
  for (const a of ids) {
    for (const b of ids) {
      if (posOf.get(a)! < posOf.get(b)! && rand() < 0.12) {
        // a comes before b in perm => b depends on a.
        refs.add(pairKey(b, a));
      }
    }
  }
  const dependsOn = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const key of refs) {
    const [from, to] = key.split('|') as [string, string];
    dependsOn.get(from)!.push(to);
  }
  const g = createGraph(
    ids.map((id) => ({ id, dependsOn: dependsOn.get(id)! })),
  );

  const ROUNDS = 800;
  let accepted = 0;
  let rejected = 0;
  let reorders = 0;
  for (let round = 0; round < ROUNDS; round++) {
    // Build a random batch: up to 4 removals of existing refs and up to 4
    // additions of brand-new refs (endpoints exist, no duplicates).
    const existing = [...refs];
    const remove: Ref[] = [];
    const removeKeys = new Set<string>();
    const removeCount = Math.floor(rand() * 5);
    for (let k = 0; k < removeCount && existing.length > 0; k++) {
      const key = existing[Math.floor(rand() * existing.length)]!;
      if (removeKeys.has(key)) continue;
      removeKeys.add(key);
      const [from, to] = key.split('|') as [string, string];
      remove.push({ from, to });
    }
    const add: Ref[] = [];
    const addKeys = new Set<string>();
    const addCount = Math.floor(rand() * 5);
    for (let k = 0; k < addCount; k++) {
      const from = ids[Math.floor(rand() * N)]!;
      const to = ids[Math.floor(rand() * N)]!;
      if (from === to) continue;
      const key = pairKey(from, to);
      // Input guarantee: additions target refs absent from the original
      // (current) graph, and no ref appears twice in a batch.
      if (refs.has(key) || addKeys.has(key) || removeKeys.has(key)) continue;
      addKeys.add(key);
      add.push({ from, to });
    }
    const batch: Batch = { remove, add };

    const candidate = new Set(refs);
    for (const key of removeKeys) candidate.delete(key);
    for (const key of addKeys) candidate.add(key);
    const expectCycle = hasCycle(ids, candidate);

    const before = g.snapshot();
    const result = g.applyBatch(batch);
    assert.equal(
      result.ok,
      !expectCycle,
      `round ${round}: accept mismatch (batch ${JSON.stringify(batch)})`,
    );
    const after = g.snapshot();
    if (result.ok) {
      accepted++;
      assert.deepEqual(
        refSetOf(after.refs),
        candidate,
        `round ${round}: committed ref set mismatch`,
      );
      assertValidSnapshot(after, ids);
      if (before.order.some((id, i) => after.order[i] !== id)) reorders++;
      refs.clear();
      for (const key of candidate) refs.add(key);
    } else {
      rejected++;
      if (!result.ok) {
        assertValidWitness(result.cycle, candidate);
      }
      assertSameSnapshot(before, after);
    }
  }
  assert.ok(accepted > 100, `expected many accepts, got ${accepted}`);
  assert.ok(rejected > 20, `expected some rejects, got ${rejected}`);
  assert.ok(reorders > 20, `expected some reorders, got ${reorders}`);
});
