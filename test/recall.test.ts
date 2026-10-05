import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildIndex, recall } from '../src/index.js';
import type { HistoryRecord, Interval, RecallResult } from '../src/index.js';

function toPlain(result: RecallResult): Record<string, Interval[]> {
  const obj: Record<string, Interval[]> = {};
  for (const [id, ivs] of result) {
    obj[id] = ivs.map((iv) => ({ start: iv.start, end: iv.end }));
  }
  return obj;
}

// 供应商 A 入库 100，供应商 B 入库 200。
// AB = A[10,60) ++ B[100,180)            （拼箱，长 130）
// S  = AB[40,70)                          （跨界拆分，长 30：前 10 来自 A，后 20 来自 B）
// M  = mix(S[12,14), C[0,10)) -> 数量 5   （很小一段投用混料）
const records: HistoryRecord[] = [
  { kind: 'mix', batchId: 'M', quantity: 5, inputs: [
    { parentId: 'S', start: 12, end: 14 },
    { parentId: 'C', start: 0, end: 10 },
  ] },
  { kind: 'repack', batchId: 'S', inputs: [{ parentId: 'AB', start: 40, end: 70 }] },
  { kind: 'receipt', batchId: 'B', quantity: 200 },
  { kind: 'repack', batchId: 'AB', inputs: [
    { parentId: 'A', start: 10, end: 60 },
    { parentId: 'B', start: 100, end: 180 },
  ] },
  { kind: 'receipt', batchId: 'A', quantity: 100 },
  { kind: 'receipt', batchId: 'C', quantity: 10 },
];

test('污染源 B：精确区间逐层传播，混料产出全部召回', () => {
  const index = buildIndex(records);
  const result = toPlain(recall(index, ['B']));
  assert.deepEqual(result, {
    B: [{ start: 0, end: 200 }],
    // 只有 B[100,180) 进入 AB，位于 AB[50,130)
    AB: [{ start: 50, end: 130 }],
    // S[10,30) 来自 AB[50,70)，即 B[100,120)
    S: [{ start: 10, end: 30 }],
    // 投用的 S[12,14) 与污染区间相交，混料产出全部受污染
    M: [{ start: 0, end: 5 }],
  });
});

test('污染源 A：未投用部分的污染不触发混料传播', () => {
  const index = buildIndex(records);
  const result = toPlain(recall(index, ['A']));
  assert.deepEqual(result, {
    A: [{ start: 0, end: 100 }],
    AB: [{ start: 0, end: 50 }],
    S: [{ start: 0, end: 10 }],
    // M 只投用了 S[12,14)，与 S[0,10) 不相交，不被召回
  });
});

test('多源查询等于分别查询的区间并集', () => {
  const index = buildIndex(records);
  const together = recall(index, ['A', 'B']);
  const fromA = recall(index, ['A']);
  const fromB = recall(index, ['B']);
  const merged = new Map<string, Interval[]>();
  for (const partial of [fromA, fromB]) {
    for (const [id, ivs] of partial) {
      merged.set(id, [...(merged.get(id) ?? []), ...ivs]);
    }
  }
  const expected = new Map<string, Interval[]>();
  for (const [id, ivs] of merged) {
    const sorted = ivs.slice().sort((x, y) => x.start - y.start);
    const out: Interval[] = [];
    for (const iv of sorted) {
      const last = out[out.length - 1];
      if (last && iv.start <= last.end) {
        out[out.length - 1] = { start: last.start, end: Math.max(last.end, iv.end) };
      } else {
        out.push({ ...iv });
      }
    }
    expected.set(id, out);
  }
  assert.deepEqual(toPlain(together), toPlain(expected));
});

test('结果区间有序、不重叠、相邻已合并', () => {
  const index = buildIndex(records);
  for (const [, ivs] of recall(index, ['A', 'B'])) {
    for (let i = 0; i < ivs.length; i++) {
      assert.ok(ivs[i]!.start < ivs[i]!.end);
      if (i > 0) assert.ok(ivs[i]!.start > ivs[i - 1]!.end);
    }
  }
});
