import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../src/index.ts';
import {
  assertSameSnapshot,
  assertValidSnapshot,
  assertValidWitness,
  refSetOf,
  pairKey,
} from './helpers.ts';

// Existing ref: a depends on b. The two additions "c depends on a" and
// "b depends on c" are each legal against the original graph, but together
// they close the cycle a -> b -> c -> a (dependency direction).
function buildGraph() {
  return createGraph([
    { id: 'a', dependsOn: ['b'] },
    { id: 'b', dependsOn: [] },
    { id: 'c', dependsOn: [] },
    { id: 'd', dependsOn: [] },
  ]);
}

test('individually legal additions forming a joint cycle are rejected', () => {
  const g = buildGraph();
  // Sanity: each addition alone is accepted.
  for (const ref of [
    { from: 'c', to: 'a' },
    { from: 'b', to: 'c' },
  ]) {
    const single = buildGraph();
    const r = single.applyBatch({ remove: [], add: [ref] });
    assert.ok(r.ok, `${ref.from} depends on ${ref.to} alone is legal`);
  }

  const before = g.snapshot();
  const result = g.applyBatch({
    remove: [],
    add: [
      { from: 'c', to: 'a' },
      { from: 'b', to: 'c' },
    ],
  });
  assert.ok(!result.ok, 'joint cycle must be rejected');
  if (result.ok) return;

  // Candidate final graph = original refs + added refs (no removals here).
  const candidate = refSetOf(before.refs);
  candidate.add(pairKey('c', 'a'));
  candidate.add(pairKey('b', 'c'));
  assertValidWitness(result.cycle, candidate);

  // Rejection must leave graph and execution order exactly as before.
  assertSameSnapshot(before, g.snapshot());

  // Afterwards, a legal commit that forces reordering still works.
  const after = g.applyBatch({ remove: [], add: [{ from: 'a', to: 'c' }] });
  assert.ok(after.ok, 'legal reorder commit after rejection must succeed');
  const snap = g.snapshot();
  assertValidSnapshot(snap, ['a', 'b', 'c', 'd']);
  assert.ok(
    snap.order.indexOf('c') < snap.order.indexOf('a'),
    'c moved before a',
  );
});

test('witness contains no removed refs', () => {
  // Original refs: a->b, b->c. Batch removes a->b and adds c->a plus
  // a->c. The candidate graph has the 2-cycle a -> c -> a; the removed
  // ref a->b must not appear in the witness.
  const g = createGraph([
    { id: 'a', dependsOn: ['b'] },
    { id: 'b', dependsOn: ['c'] },
    { id: 'c', dependsOn: [] },
  ]);
  const before = g.snapshot();
  // Remove a->b (breaks nothing), add c->a (cycle b->c->a->b? a->b removed!)
  // and b->a (cycle a->c? no). Candidate refs: b->c, c->a, b->a.
  // Dependency cycle: a -> c? c->a means c depends on a. b->c, c->a, b->a:
  // no cycle (b->c->a, b->a consistent). Make it cyclic: add c->a and a->c?
  // a->c does not exist originally (a->b, b->c only transitively). So:
  const result = g.applyBatch({
    remove: [{ from: 'a', to: 'b' }],
    add: [
      { from: 'c', to: 'a' },
      { from: 'a', to: 'c' },
    ],
  });
  assert.ok(!result.ok, 'c->a plus a->c forms a 2-cycle');
  if (result.ok) return;
  const candidate = refSetOf(before.refs);
  candidate.delete(pairKey('a', 'b'));
  candidate.add(pairKey('c', 'a'));
  candidate.add(pairKey('a', 'c'));
  assertValidWitness(result.cycle, candidate);
  // The removed ref must not appear anywhere in the witness.
  for (let i = 0; i + 1 < result.cycle.length; i++) {
    assert.notEqual(
      pairKey(result.cycle[i]!, result.cycle[i + 1]!),
      pairKey('a', 'b'),
      'witness must not use the removed ref',
    );
  }
  assertSameSnapshot(before, g.snapshot());
});

test('batch with removals and additions where only the joint final graph matters', () => {
  // Chain: a->b->c->d (a depends on b, ...). Remove b->c and c->d,
  // add c->b and d->c (reverse the middle), plus d->a would cycle only if
  // a still reaches d. Final refs: a->b, c->b, d->c, d->a? d->a plus a->b
  // plus ... a->b, b nothing. d->c->b, d->a->b: acyclic. Must accept.
  const g = createGraph([
    { id: 'a', dependsOn: ['b'] },
    { id: 'b', dependsOn: ['c'] },
    { id: 'c', dependsOn: ['d'] },
    { id: 'd', dependsOn: [] },
  ]);
  const result = g.applyBatch({
    remove: [
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
    ],
    add: [
      { from: 'c', to: 'b' },
      { from: 'd', to: 'c' },
      { from: 'd', to: 'a' },
    ],
  });
  assert.ok(result.ok, 'final acyclic graph must be accepted');
  const snap = g.snapshot();
  assertValidSnapshot(snap, ['a', 'b', 'c', 'd']);
  const refs = refSetOf(snap.refs);
  for (const key of ['a|b', 'c|b', 'd|c', 'd|a']) {
    assert.ok(refs.has(key), `expected ref ${key}`);
  }
  assert.equal(snap.refs.length, 4);
});
