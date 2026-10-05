import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../src/index.ts';
import {
  assertValidSnapshot,
  refSetOf,
  pairKey,
} from './helpers.ts';

test('createGraph + snapshot: refs and valid execution order', () => {
  const g = createGraph([
    { id: 'a', dependsOn: ['b', 'c'] },
    { id: 'b', dependsOn: ['c'] },
    { id: 'c', dependsOn: [] },
  ]);
  const snap = g.snapshot();
  assert.equal(snap.refs.length, 3);
  const refs = refSetOf(snap.refs);
  assert.ok(refs.has(pairKey('a', 'b')));
  assert.ok(refs.has(pairKey('a', 'c')));
  assert.ok(refs.has(pairKey('b', 'c')));
  assertValidSnapshot(snap, ['a', 'b', 'c']);
});

test('createGraph rejects a cyclic initial graph', () => {
  assert.throws(() =>
    createGraph([
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ]),
  );
});

test('same-batch remove + reverse add: legal final graph must be accepted', () => {
  // a depends on b. Atomically flip the direction: remove a->b, add b->a.
  // Adding b->a before removing a->b would form a temporary cycle, but the
  // batch semantics are remove-then-add, so the final graph is a valid DAG.
  const g = createGraph([
    { id: 'a', dependsOn: ['b'] },
    { id: 'b', dependsOn: [] },
    { id: 'c', dependsOn: ['a'] },
  ]);
  const result = g.applyBatch({
    remove: [{ from: 'a', to: 'b' }],
    add: [{ from: 'b', to: 'a' }],
  });
  assert.ok(result.ok, 'batch must be accepted');
  const snap = g.snapshot();
  const refs = refSetOf(snap.refs);
  assert.ok(!refs.has(pairKey('a', 'b')), 'old ref removed');
  assert.ok(refs.has(pairKey('b', 'a')), 'reversed ref added');
  assert.ok(refs.has(pairKey('c', 'a')), 'untouched ref kept');
  assertValidSnapshot(snap, ['a', 'b', 'c']);
});

test('legal commit that requires reordering is accepted', () => {
  // Chain a depends on b depends on c. Adding "c depends on a" would cycle,
  // but adding "b depends on d" where d currently sits after b only needs a
  // reorder of the execution order.
  const g = createGraph([
    { id: 'a', dependsOn: ['b'] },
    { id: 'b', dependsOn: [] },
    { id: 'd', dependsOn: [] },
  ]);
  const before = g.snapshot();
  assert.ok(
    before.order.indexOf('d') > before.order.indexOf('b') ||
      before.order.indexOf('d') < before.order.indexOf('b'),
  );
  const result = g.applyBatch({ remove: [], add: [{ from: 'b', to: 'd' }] });
  assert.ok(result.ok);
  const snap = g.snapshot();
  assertValidSnapshot(snap, ['a', 'b', 'd']);
  assert.ok(
    snap.order.indexOf('d') < snap.order.indexOf('b'),
    'd must move before b',
  );
  assert.ok(
    snap.order.indexOf('b') < snap.order.indexOf('a'),
    'b stays before a',
  );
});

test('simple self-dependency is rejected with a witness', () => {
  const g = createGraph([
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: [] },
  ]);
  const result = g.applyBatch({ remove: [], add: [{ from: 'a', to: 'a' }] });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.deepEqual(result.cycle, ['a', 'a']);
  }
});

test('empty batch is a no-op accept', () => {
  const g = createGraph([
    { id: 'a', dependsOn: ['b'] },
    { id: 'b', dependsOn: [] },
  ]);
  const before = g.snapshot();
  const result = g.applyBatch({ remove: [], add: [] });
  assert.ok(result.ok);
  assert.equal(result.stats.total, 0);
  const after = g.snapshot();
  assert.deepEqual(after.order, before.order);
  assert.equal(after.refs.length, before.refs.length);
});
