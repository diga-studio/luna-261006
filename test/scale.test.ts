import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { analyzeFlow, replayFlow } from '../src/index.js';
import type { FlowDefinition, FlowNode } from '../src/index.js';
import { riskKey } from './helpers.js';

const STAGES = 40;

/**
 * 常见模式：每个阶段先按开关 s_i 条件产出 f_i，汇合后再按同一开关
 * 读取 f_i。40 个阶段串联，路径数 2^40（超过一万亿）。
 * safe=true 时读取被同一开关保护，永远安全；
 * safe=false 时在末尾追加无条件读取全部字段的动作（真实缺失），
 * 以及一个被其遮蔽的后续动作。
 */
function buildFlow(safe: boolean): FlowDefinition {
  const switches = Array.from({ length: STAGES }, (_, i) => `s${i}`);
  const fields = Array.from({ length: STAGES }, (_, i) => `f${i}`);
  const nodes: FlowNode[] = [];
  const stageEntry = (i: number) => (i < STAGES ? `c${i}` : safe ? 'end' : 'useAll');

  nodes.push({ id: 'entry', kind: 'entry', next: 'c0' });
  for (let i = 0; i < STAGES; i++) {
    const next = stageEntry(i + 1);
    nodes.push({ id: `c${i}`, kind: 'condition', switch: `s${i}`, onTrue: `p${i}`, onFalse: `g${i}` });
    nodes.push({ id: `p${i}`, kind: 'action', requires: [], produces: [`f${i}`], next: `g${i}` });
    nodes.push({ id: `g${i}`, kind: 'condition', switch: `s${i}`, onTrue: `u${i}`, onFalse: next });
    nodes.push({ id: `u${i}`, kind: 'action', requires: [`f${i}`], produces: [], next });
  }
  if (!safe) {
    nodes.push({
      id: 'useAll',
      kind: 'action',
      requires: fields,
      produces: [],
      next: 'later',
    });
    // 被 useAll 的更早失败遮蔽，不应产生任何报告。
    nodes.push({ id: 'later', kind: 'action', requires: ['f0'], produces: [], next: 'end' });
  }
  nodes.push({ id: 'end', kind: 'end' });
  return { switches, fields, nodes };
}

test('规模用例（安全版）：40 开关 162 节点，无报告，耗时与内存达标', () => {
  const flow = buildFlow(true);
  assert.ok(flow.nodes.length >= 160 && flow.nodes.length <= 200);

  const memBefore = process.memoryUsage().heapUsed;
  const start = Date.now();
  const { reports } = analyzeFlow(flow);
  const elapsed = Date.now() - start;
  const memDelta = process.memoryUsage().heapUsed - memBefore;

  assert.deepStrictEqual(reports, []);
  assert.ok(elapsed < 10_000, `analysis took ${elapsed}ms`);
  assert.ok(memDelta < 256 * 1024 * 1024, `heap grew ${memDelta} bytes`);
  console.log(`  safe: ${elapsed}ms, heap +${(memDelta / 1024 / 1024).toFixed(1)} MiB`);
});

test('规模用例（风险版）：报告精确的节点与字段，witness 均可复现', () => {
  const flow = buildFlow(false);

  const memBefore = process.memoryUsage().heapUsed;
  const start = Date.now();
  const { reports } = analyzeFlow(flow);
  const elapsed = Date.now() - start;
  const memDelta = process.memoryUsage().heapUsed - memBefore;

  // 恰好 40 条报告：useAll 缺 f0..f39；later 被遮蔽，无报告。
  const keys = new Set(reports.map((r) => riskKey(r.nodeId, r.field)));
  const expected = new Set(Array.from({ length: STAGES }, (_, i) => riskKey('useAll', `f${i}`)));
  assert.deepStrictEqual(keys, expected);
  assert.strictEqual(reports.length, STAGES);

  for (const r of reports) {
    const res = replayFlow(flow, r.witness);
    assert.ok(!res.ok);
    assert.strictEqual(res.failedAt, 'useAll');
    assert.ok(res.missingFields.includes(r.field));
  }

  assert.ok(elapsed < 10_000, `analysis took ${elapsed}ms`);
  assert.ok(memDelta < 256 * 1024 * 1024, `heap grew ${memDelta} bytes`);
  console.log(`  risky: ${elapsed}ms, heap +${(memDelta / 1024 / 1024).toFixed(1)} MiB`);
});
