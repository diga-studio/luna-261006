import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { analyzeFlow, replayFlow } from '../src/index';
import type { FlowDefinition } from '../src/index';

// Scenario 1: a field produced under switch s0 is read later under the
// same switch — the repeated condition protects the read, so it is safe.
const protectedReadFlow: FlowDefinition = {
  switchCount: 1,
  nodes: [
    { id: 'entry', kind: 'entry', next: 'c1' },
    { id: 'c1', kind: 'condition', switchIndex: 0, onTrue: 'produce', onFalse: 'c2' },
    { id: 'produce', kind: 'action', requires: [], produces: ['doc'], next: 'c2' },
    { id: 'c2', kind: 'condition', switchIndex: 0, onTrue: 'read', onFalse: 'end' },
    { id: 'read', kind: 'action', requires: ['doc'], produces: [], next: 'end' },
    { id: 'end', kind: 'end' },
  ],
};

// Same shape, but the read sits on the opposite branch: unprotected.
const unprotectedReadFlow: FlowDefinition = {
  switchCount: 1,
  nodes: [
    { id: 'entry', kind: 'entry', next: 'c1' },
    { id: 'c1', kind: 'condition', switchIndex: 0, onTrue: 'produce', onFalse: 'c2' },
    { id: 'produce', kind: 'action', requires: [], produces: ['doc'], next: 'c2' },
    { id: 'c2', kind: 'condition', switchIndex: 0, onTrue: 'end', onFalse: 'read' },
    { id: 'read', kind: 'action', requires: ['doc'], produces: [], next: 'end' },
    { id: 'end', kind: 'end' },
  ],
};

// Scenario 2: each branch produces a different field; both are used
// after the merge, so each branch choice starves the other field.
const divergentProduceFlow: FlowDefinition = {
  switchCount: 1,
  nodes: [
    { id: 'entry', kind: 'entry', next: 'c' },
    { id: 'c', kind: 'condition', switchIndex: 0, onTrue: 'makeA', onFalse: 'makeB' },
    { id: 'makeA', kind: 'action', requires: [], produces: ['A'], next: 'use' },
    { id: 'makeB', kind: 'action', requires: [], produces: ['B'], next: 'use' },
    { id: 'use', kind: 'action', requires: ['A', 'B'], produces: [], next: 'end' },
    { id: 'end', kind: 'end' },
  ],
};

// Scenario 3: the first action always fails, so the later action's
// missing field must NOT be reported (shadowed by the earlier failure).
const shadowedFlow: FlowDefinition = {
  switchCount: 1,
  nodes: [
    { id: 'entry', kind: 'entry', next: 'a1' },
    { id: 'a1', kind: 'action', requires: ['X', 'Y'], produces: [], next: 'a2' },
    { id: 'a2', kind: 'action', requires: ['Z'], produces: [], next: 'end' },
    { id: 'end', kind: 'end' },
  ],
};

test('repeated condition protecting a field read is safe', () => {
  const result = analyzeFlow(protectedReadFlow);
  assert.equal(result.safe, true);
  assert.deepEqual(result.reports, []);
});

test('unprotected read after merge is reported with a witness', () => {
  const result = analyzeFlow(unprotectedReadFlow);
  assert.equal(result.safe, false);
  assert.equal(result.reports.length, 1);
  const report = result.reports[0]!;
  assert.equal(report.nodeId, 'read');
  assert.equal(report.field, 'doc');
  assert.equal(report.witness.length, 1);
  assert.equal(report.witness[0], false);
});

test('divergent branches starving each other are both reported', () => {
  const result = analyzeFlow(divergentProduceFlow);
  assert.equal(result.reports.length, 2);
  const byField = new Map(result.reports.map((r) => [r.field, r]));
  const reportA = byField.get('A')!;
  const reportB = byField.get('B')!;
  assert.equal(reportA.nodeId, 'use');
  assert.equal(reportB.nodeId, 'use');
  // Witnesses must pick the branch that did not produce the field.
  assert.equal(reportA.witness[0], false);
  assert.equal(reportB.witness[0], true);
  // Each witness really reproduces its first failure.
  for (const report of result.reports) {
    const replay = replayFlow(divergentProduceFlow, report.witness);
    assert.equal(replay.ok, false);
    if (!replay.ok) {
      assert.equal(replay.failedNode, report.nodeId);
      assert.ok(replay.missingFields.includes(report.field));
    }
  }
});

test('earlier failure shadows later missing fields', () => {
  const result = analyzeFlow(shadowedFlow);
  const combos = result.reports.map((r) => `${r.nodeId}:${r.field}`).sort();
  assert.deepEqual(combos, ['a1:X', 'a1:Y']);
});

test('replay walks the protected flow without failing', () => {
  const on = replayFlow(protectedReadFlow, [true]);
  assert.deepEqual(on, { ok: true, path: ['entry', 'c1', 'produce', 'c2', 'read', 'end'] });
  const off = replayFlow(protectedReadFlow, [false]);
  assert.deepEqual(off, { ok: true, path: ['entry', 'c1', 'c2', 'end'] });
});

test('replay reports every missing field of the first failure', () => {
  const result = replayFlow(shadowedFlow, [true]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failedNode, 'a1');
    assert.deepEqual(result.missingFields, ['X', 'Y']);
    assert.deepEqual(result.path, ['entry', 'a1']);
  }
});

test('replay of divergent flow fails only on the starved field', () => {
  const result = replayFlow(divergentProduceFlow, [false]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failedNode, 'use');
    assert.deepEqual(result.missingFields, ['A']);
  }
});
