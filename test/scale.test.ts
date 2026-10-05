import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../src/index.ts';
import { assertValidSnapshot } from './helpers.ts';

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

test('100k-node chain with 20k small shortcut commits', () => {
  const N = 100_000;
  const ids = Array.from({ length: N }, (_, i) => `n${i}`);
  // Chain: n_i depends on n_{i-1}.
  const g = createGraph(
    ids.map((id, i) => ({ id, dependsOn: i > 0 ? [ids[i - 1]!] : [] })),
  );
  const rand = mulberry32(42);
  const COMMITS = 20_000;
  // Track every shortcut ever added so additions always target refs absent
  // from the current graph (input guarantee).
  const added = new Set<string>();
  const start = performance.now();
  for (let c = 0; c < COMMITS; c++) {
    // Each commit adds up to 4 shortcut refs along the existing dependency
    // direction (from a node to one of its ancestors). These never require
    // reordering and must always be accepted.
    const add = [];
    for (let k = 0; k < 4; k++) {
      const i = 2 + Math.floor(rand() * (N - 2));
      const j = Math.floor(rand() * (i - 1));
      const key = `${i}|${j}`;
      if (added.has(key)) continue;
      added.add(key);
      add.push({ from: ids[i]!, to: ids[j]! });
    }
    const result = g.applyBatch({ remove: [], add });
    assert.ok(result.ok, `commit ${c} must be accepted`);
  }
  const elapsed = performance.now() - start;
  console.log(
    `  20k commits on 100k-node chain: ${elapsed.toFixed(0)}ms ` +
      `(${(elapsed / COMMITS).toFixed(3)}ms/commit)`,
  );
  const snap = g.snapshot();
  assert.equal(snap.refs.length, N - 1 + added.size);
  assertValidSnapshot(snap, ids);
});

test('32-node component beside a huge background graph: access stats stay local', () => {
  const BACKGROUND = 100_000;
  const COMP = 32;
  const bgIds = Array.from({ length: BACKGROUND }, (_, i) => `bg${i}`);
  const compIds = Array.from({ length: COMP }, (_, i) => `c${i}`);
  const rules = [
    ...bgIds.map((id, i) => ({
      id,
      dependsOn: i > 0 ? [bgIds[i - 1]!] : [],
    })),
    // Component: a chain c0 <- c1 <- ... <- c31 (c_i depends on c_{i-1}).
    ...compIds.map((id, i) => ({
      id,
      dependsOn: i > 0 ? [compIds[i - 1]!] : [],
    })),
  ];
  const g = createGraph(rules);
  const allIds = [...bgIds, ...compIds];
  assertValidSnapshot(g.snapshot(), allIds);

  const rand = mulberry32(7);
  const FLIPS = 2_000;
  let maxTotal = 0;
  let sumTotal = 0;
  const start = performance.now();
  for (let f = 0; f < FLIPS; f++) {
    // Flip one adjacent ref inside the 32-node component:
    // remove "c_{i} depends on c_{i-1}", add "c_{i-1} depends on c_i".
    // The chain has no other path between the two, so the final graph is
    // always acyclic, but the execution order must be rearranged locally.
    const i = 1 + Math.floor(rand() * (COMP - 1));
    const upper = compIds[i]!;
    const lower = compIds[i - 1]!;
    const result = g.applyBatch({
      remove: [{ from: upper, to: lower }],
      add: [{ from: lower, to: upper }],
    });
    assert.ok(result.ok, `flip ${f} must be accepted`);
    maxTotal = Math.max(maxTotal, result.stats.total);
    sumTotal += result.stats.total;
  }
  const elapsed = performance.now() - start;
  console.log(
    `  ${FLIPS} flips in 32-node component (background ${BACKGROUND}): ` +
      `${elapsed.toFixed(0)}ms, max stats.total=${maxTotal}, ` +
      `avg=${(sumTotal / FLIPS).toFixed(1)}`,
  );
  assert.ok(
    maxTotal <= 10_000,
    `each commit must stay within 10k record accesses, got ${maxTotal}`,
  );
  assertValidSnapshot(g.snapshot(), allIds);
});

test('large-range reorder across two 5k chains stays correct', () => {
  const N = 5_000;
  const aIds = Array.from({ length: N }, (_, i) => `a${i}`);
  const bIds = Array.from({ length: N }, (_, i) => `b${i}`);
  const g = createGraph([
    ...aIds.map((id, i) => ({ id, dependsOn: i > 0 ? [aIds[i - 1]!] : [] })),
    ...bIds.map((id, i) => ({ id, dependsOn: i > 0 ? [bIds[i - 1]!] : [] })),
  ]);
  // a_2500 depends on b_4999: a large slice of the B chain must move before
  // a_2500 in the execution order. Legal (the chains were disconnected).
  const result = g.applyBatch({
    remove: [],
    add: [{ from: aIds[2500]!, to: bIds[N - 1]! }],
  });
  assert.ok(result.ok);
  const snap = g.snapshot();
  assertValidSnapshot(snap, [...aIds, ...bIds]);
  assert.ok(
    snap.order.indexOf(bIds[N - 1]!) < snap.order.indexOf(aIds[2500]!),
    'b chain tail must move before a2500',
  );
});
