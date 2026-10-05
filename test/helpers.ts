import { strict as assert } from 'node:assert';
import { analyzeFlow, replayFlow } from '../src/index.js';
import type { FlowDefinition } from '../src/index.js';

export function riskKey(nodeId: string, field: string): string {
  return nodeId + '::' + field;
}

/** 暴力枚举全部开关输入，用 replay 收集真实可达的首次失败集合。 */
export function bruteForceRisks(flow: FlowDefinition): Set<string> {
  const n = flow.switches.length;
  if (n > 24) throw new Error('too many switches for brute force');
  const risks = new Set<string>();
  for (let mask = 0; mask < 1 << n; mask++) {
    const assignment = flow.switches.map((_, i) => (mask & (1 << i)) !== 0);
    const res = replayFlow(flow, assignment);
    if (!res.ok) {
      for (const f of res.missingFields) risks.add(riskKey(res.failedAt, f));
    }
  }
  return risks;
}

/**
 * 校验 analyzeFlow 的报告集合与暴力枚举结果完全一致，
 * 且每条报告的 witness 都能复现对应的首次失败（此前无失败由 replay 语义保证）。
 */
export function assertMatchesBruteForce(flow: FlowDefinition): void {
  const expected = bruteForceRisks(flow);
  const { reports } = analyzeFlow(flow);
  const actual = new Set(reports.map((r) => riskKey(r.nodeId, r.field)));
  assert.deepStrictEqual(actual, expected, 'report set mismatch');
  assert.strictEqual(reports.length, actual.size, 'reports must be deduplicated');
  for (const r of reports) {
    assert.strictEqual(r.witness.length, flow.switches.length, 'witness must be complete');
    const res = replayFlow(flow, r.witness);
    assert.ok(!res.ok, `witness for ${r.nodeId}/${r.field} should fail`);
    assert.strictEqual(res.failedAt, r.nodeId);
    assert.ok(res.missingFields.includes(r.field));
  }
}
