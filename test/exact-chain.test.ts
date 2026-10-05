import { test } from 'node:test';
import { deepEqual } from 'node:assert/strict';
import { buildIndex, recall } from '../src/recall';
import { HistoryRecord, RecallResult } from '../src/types';

/**
 * 场景：
 *  - 供应商 A 入库 A(100)，供应商 B 入库 B(50)
 *  - P1 = 拼箱[A[10,60), B[0,40)]  → A[10,60)→P1[0,50)，B[0,40)→P1[50,90)
 *  - P2 = 拆分[P1[40,70)]          → 跨来源边界：P2[0,10) 来自 A[50,60)，P2[10,30) 来自 B[0,20)
 *  - M1 = 混料(投用 P2[5,12)) qty 7 → 跨边界的一小段
 *  - M2 = 混料(投用 P2[20,25)) qty 4 → 只投用来自 B 的部分
 *  - P3 = 拼箱[B[40,50)]            → 与 A 无关的旁支
 * 记录故意打乱顺序，不保证依赖序。
 */
const records: HistoryRecord[] = [
  { kind: 'mix', id: 'M1', inputs: [{ parent: 'P2', start: 5, end: 12 }], qty: 7 },
  { kind: 'repack', id: 'P2', inputs: [{ parent: 'P1', start: 40, end: 70 }] },
  { kind: 'intake', id: 'A', qty: 100 },
  { kind: 'repack', id: 'P3', inputs: [{ parent: 'B', start: 40, end: 50 }] },
  { kind: 'intake', id: 'B', qty: 50 },
  {
    kind: 'repack',
    id: 'P1',
    inputs: [
      { parent: 'A', start: 10, end: 60 },
      { parent: 'B', start: 0, end: 40 },
    ],
  },
  { kind: 'mix', id: 'M2', inputs: [{ parent: 'P2', start: 20, end: 25 }], qty: 4 },
];

function toPlain(result: RecallResult): Record<string, [number, number][]> {
  const obj: Record<string, [number, number][]> = {};
  for (const [id, ranges] of result) {
    obj[id] = ranges.map((r) => [r.start, r.end]);
  }
  return obj;
}

test('召回源 A：沿拼箱/拆分精确映射，跨边界小段触发 M1 全部召回', () => {
  const index = buildIndex(records);
  deepEqual(toPlain(recall(index, ['A'])), {
    A: [[0, 100]],
    P1: [[0, 50]], // 只有来自 A 的前半段，B 侧 [50,90) 不被误召回
    P2: [[0, 10]], // 跨边界拆分后只有来自 A 的部分
    M1: [[0, 7]], // 投用区间 [5,12) 与污染 [0,10) 相交 → 产出全部召回
    // B、P3、M2 均不出现：共享拼箱不等于共同受污染，未投用 B 段不触发 M2
  });
});

test('召回源 B：对称地精确映射到另一侧', () => {
  const index = buildIndex(records);
  deepEqual(toPlain(recall(index, ['B'])), {
    B: [[0, 50]],
    P1: [[50, 90]],
    P2: [[10, 30]],
    P3: [[0, 10]],
    M1: [[0, 7]], // 投用区间 [5,12) 与污染 [10,30) 交于 [10,12) → 全部召回
    M2: [[0, 4]], // 投用区间 [20,25) 被污染 → 全部召回
    // A 不出现
  });
});

test('多源召回等于分别召回后逐批次取区间并集', () => {
  const index = buildIndex(records);
  const together = toPlain(recall(index, ['A', 'B']));
  const fromA = toPlain(recall(index, ['A']));
  const fromB = toPlain(recall(index, ['B']));
  const merged: Record<string, [number, number][]> = {};
  for (const src of [fromA, fromB]) {
    for (const [id, ranges] of Object.entries(src)) {
      merged[id] = (merged[id] ?? []).concat(ranges);
    }
  }
  for (const id of Object.keys(merged)) {
    merged[id]!.sort((a, b) => a[0] - b[0]);
    // 合并相邻（本题中 A∪B 在 P1/P2 上恰好相接）
    const out: [number, number][] = [];
    for (const [s, e] of merged[id]!) {
      const last = out[out.length - 1];
      if (last && last[1] >= s) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    merged[id] = out;
  }
  deepEqual(together, merged);
  // 并集在 P1、P2 上相邻区间已合并为整批
  deepEqual(together['P1'], [[0, 90]]);
  deepEqual(together['P2'], [[0, 30]]);
});

test('同一索引可重复查询且结果一致', () => {
  const index = buildIndex(records);
  const first = toPlain(recall(index, ['A']));
  const second = toPlain(recall(index, ['A']));
  deepEqual(first, second);
});
