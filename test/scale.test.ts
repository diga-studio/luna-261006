import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { analyzeFlow, replayFlow } from '../src/index';
import type { FlowDefinition, FlowNode } from '../src/index';

const SWITCHES = 40;

/**
 * The scale scenario from the requirements:
 *  - stage 1: for each switch i, a condition on switch i guards an action
 *    producing field Fi (true branch produces, false branch skips);
 *  - stage 2: for each i, a condition on switch guardOf(i) guards an action
 *    requiring field FneedOf(i).
 * 162 nodes, 40 switches => 2^40 > 1 trillion executions, 2^80 paths.
 */
function buildPipelineFlow(
  guardOf: (i: number) => number,
  needOf: (i: number) => number,
): FlowDefinition {
  const nodes: FlowNode[] = [];
  const field = (i: number) => `F${i}`;
  nodes.push({ id: 'entry', kind: 'entry', next: 'c0' });

  for (let i = 0; i < SWITCHES; i++) {
    const nextCond = i + 1 < SWITCHES ? `c${i + 1}` : 'd0';
    nodes.push({
      id: `c${i}`,
      kind: 'condition',
      switchIndex: i,
      onTrue: `p${i}`,
      onFalse: nextCond,
    });
    nodes.push({
      id: `p${i}`,
      kind: 'action',
      requires: [],
      produces: [field(i)],
      next: nextCond,
    });
  }
  for (let i = 0; i < SWITCHES; i++) {
    const nextCond = i + 1 < SWITCHES ? `d${i + 1}` : 'end';
    nodes.push({
      id: `d${i}`,
      kind: 'condition',
      switchIndex: guardOf(i),
      onTrue: `u${i}`,
      onFalse: nextCond,
    });
    nodes.push({
      id: `u${i}`,
      kind: 'action',
      requires: [field(needOf(i))],
      produces: [],
      next: nextCond,
    });
  }
  nodes.push({ id: 'end', kind: 'end' });
  return { switchCount: SWITCHES, nodes };
}

const TEN_SECONDS_MS = 10_000;
const MAX_HEAP_GROWTH_BYTES = 256 * 1024 * 1024;

test('safe 40-switch pipeline yields no reports, fast and lean', () => {
  const flow = buildPipelineFlow(
    (i) => i,
    (i) => i,
  );
  assert.equal(flow.nodes.length, 162);
  const heapBefore = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  const result = analyzeFlow(flow);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;

  assert.equal(result.safe, true);
  assert.deepEqual(result.reports, []);
  assert.ok(elapsedMs < TEN_SECONDS_MS, `took ${elapsedMs}ms`);
  assert.ok(heapGrowth < MAX_HEAP_GROWTH_BYTES, `heap grew ${heapGrowth} bytes`);
});

test('pipeline with one real mismatch reports exactly that node and field', () => {
  // Reader 20 is guarded by switch 21 but needs F20: a real first failure.
  const flow = buildPipelineFlow(
    (i) => (i === 20 ? 21 : i),
    (i) => i,
  );
  const started = process.hrtime.bigint();
  const result = analyzeFlow(flow);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(result.safe, false);
  assert.equal(result.reports.length, 1);
  const report = result.reports[0]!;
  assert.equal(report.nodeId, 'u20');
  assert.equal(report.field, 'F20');
  assert.equal(report.witness.length, SWITCHES);
  assert.equal(report.witness[20], false);
  assert.equal(report.witness[21], true);
  assert.ok(elapsedMs < TEN_SECONDS_MS, `took ${elapsedMs}ms`);

  // The witness reproduces the first failure exactly.
  const replay = replayFlow(flow, report.witness);
  assert.equal(replay.ok, false);
  if (!replay.ok) {
    assert.equal(replay.failedNode, 'u20');
    assert.deepEqual(replay.missingFields, ['F20']);
  }
});
