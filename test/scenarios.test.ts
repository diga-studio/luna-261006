import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { analyzeFlow, replayFlow } from '../src/index.js';
import type { FlowDefinition } from '../src/index.js';
import { assertMatchesBruteForce, riskKey } from './helpers.js';

test('重复条件保护字段读取：同一开关前后检查，无风险', () => {
  const flow: FlowDefinition = {
    switches: ['s'],
    fields: ['doc'],
    nodes: [
      { id: 'entry', kind: 'entry', next: 'c1' },
      { id: 'c1', kind: 'condition', switch: 's', onTrue: 'gen', onFalse: 'c2' },
      { id: 'gen', kind: 'action', requires: [], produces: ['doc'], next: 'c2' },
      { id: 'c2', kind: 'condition', switch: 's', onTrue: 'use', onFalse: 'end' },
      { id: 'use', kind: 'action', requires: ['doc'], produces: [], next: 'end' },
      { id: 'end', kind: 'end' },
    ],
  };
  assertMatchesBruteForce(flow);
  assert.deepStrictEqual(analyzeFlow(flow).reports, []);
});

test('不同分支产生不同字段并在汇合后使用：两侧各缺对方字段', () => {
  const flow: FlowDefinition = {
    switches: ['s'],
    fields: ['x', 'y'],
    nodes: [
      { id: 'entry', kind: 'entry', next: 'c' },
      { id: 'c', kind: 'condition', switch: 's', onTrue: 'makeX', onFalse: 'makeY' },
      { id: 'makeX', kind: 'action', requires: [], produces: ['x'], next: 'use' },
      { id: 'makeY', kind: 'action', requires: [], produces: ['y'], next: 'use' },
      { id: 'use', kind: 'action', requires: ['x', 'y'], produces: [], next: 'end' },
      { id: 'end', kind: 'end' },
    ],
  };
  assertMatchesBruteForce(flow);
  const keys = new Set(analyzeFlow(flow).reports.map((r) => riskKey(r.nodeId, r.field)));
  assert.deepStrictEqual(keys, new Set(['use::x', 'use::y']));
});

test('前面的失败遮蔽后续缺失：只在更早失败之后发生的缺失不报告', () => {
  const flow: FlowDefinition = {
    switches: ['s'],
    fields: ['x', 'y'],
    nodes: [
      { id: 'entry', kind: 'entry', next: 'c' },
      { id: 'c', kind: 'condition', switch: 's', onTrue: 'makeX', onFalse: 'u1' },
      { id: 'makeX', kind: 'action', requires: [], produces: ['x'], next: 'u1' },
      { id: 'u1', kind: 'action', requires: ['x'], produces: [], next: 'u2' },
      { id: 'u2', kind: 'action', requires: ['y'], produces: [], next: 'end' },
      { id: 'end', kind: 'end' },
    ],
  };
  assertMatchesBruteForce(flow);
  const keys = new Set(analyzeFlow(flow).reports.map((r) => riskKey(r.nodeId, r.field)));
  // s=false 时 u1 缺 x 先失败，遮蔽 u2 缺 y；s=true 时 u2 缺 y。
  assert.deepStrictEqual(keys, new Set(['u1::x', 'u2::y']));
});

test('复现能力：成功与失败路径的节点序列及缺失字段', () => {
  const flow: FlowDefinition = {
    switches: ['s'],
    fields: ['x'],
    nodes: [
      { id: 'entry', kind: 'entry', next: 'c' },
      { id: 'c', kind: 'condition', switch: 's', onTrue: 'makeX', onFalse: 'use' },
      { id: 'makeX', kind: 'action', requires: [], produces: ['x'], next: 'use' },
      { id: 'use', kind: 'action', requires: ['x'], produces: [], next: 'end' },
      { id: 'end', kind: 'end' },
    ],
  };
  const ok = replayFlow(flow, [true]);
  assert.deepStrictEqual(ok, { ok: true, path: ['entry', 'c', 'makeX', 'use', 'end'] });
  const bad = replayFlow(flow, [false]);
  assert.deepStrictEqual(bad, {
    ok: false,
    path: ['entry', 'c', 'use'],
    failedAt: 'use',
    missingFields: ['x'],
  });
});
