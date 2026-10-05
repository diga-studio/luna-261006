import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildIndex, recall } from '../src/index.js';
import type { HistoryRecord, RecallStats } from '../src/index.js';

test('多轮拆分与汇合：路径数指数增长但工作量按节点数有界', () => {
  // 每轮：Z = X[0,h) ++ Y[0,h)，W = X[h,q) ++ Y[h,q)。
  // 从 R 到第 k 轮任一批次的路径数为 2^k，但节点数只有 2k+1。
  const rounds = 40;
  const q = 2 ** rounds; // 约 1.1 万亿
  const records: HistoryRecord[] = [{ kind: 'receipt', batchId: 'R', quantity: q }];
  const half = q / 2;
  const quarter = q / 4;
  records.push({ kind: 'repack', batchId: 'Z0', inputs: [{ parentId: 'R', start: 0, end: half }] });
  records.push({ kind: 'repack', batchId: 'W0', inputs: [{ parentId: 'R', start: half, end: q }] });
  for (let i = 1; i < rounds; i++) {
    // 每轮两个新批次都同时依赖上一轮的两个批次，路径数每轮翻倍。
    records.push({ kind: 'repack', batchId: `Z${i}`, inputs: [
      { parentId: `Z${i - 1}`, start: 0, end: quarter },
      { parentId: `W${i - 1}`, start: 0, end: quarter },
    ] });
    records.push({ kind: 'repack', batchId: `W${i}`, inputs: [
      { parentId: `Z${i - 1}`, start: quarter, end: half },
      { parentId: `W${i - 1}`, start: quarter, end: half },
    ] });
  }
  const index = buildIndex(records);
  const stats: RecallStats = { visitedBatches: 0, scannedUsages: 0 };
  const result = recall(index, ['R'], stats);

  const totalBatches = 1 + 2 * rounds;
  // 全链路受污染：每个批次整批召回。
  assert.equal(result.size, totalBatches);
  for (const [, ivs] of result) {
    assert.equal(ivs.length, 1);
  }
  // 末轮批次数量仍为 q/2（万亿级），查询瞬间完成即证明未逐单位展开。
  assert.deepEqual(result.get(`Z${rounds - 1}`), [{ start: 0, end: half }]);
  // 工作量与节点数同阶，与 2^40 条路径无关。
  assert.ok(stats.visitedBatches <= totalBatches);
  assert.ok(stats.scannedUsages <= 4 * rounds);
});

test('巨型拼箱中很小一段受影响：跳过不相交的后续取用引用', () => {
  // GIANT = S[0,10) ++ FILLER[0, 1e12)，只有前 10 个单位受污染。
  // GIANT 被 5 万条记录以互不相交的区间取用，只有第一条覆盖污染段。
  const fan = 50_000;
  const chunk = 20_000_000; // 每条取用量，5万条共 1e12
  const records: HistoryRecord[] = [
    { kind: 'receipt', batchId: 'S', quantity: 10 },
    { kind: 'receipt', batchId: 'FILLER', quantity: 10 ** 12 },
    { kind: 'repack', batchId: 'GIANT', inputs: [
      { parentId: 'S', start: 0, end: 10 },
      { parentId: 'FILLER', start: 0, end: 10 ** 12 },
    ] },
  ];
  // 第一条取用覆盖受污染的 [0,10)。
  records.push({ kind: 'repack', batchId: 'HIT', inputs: [{ parentId: 'GIANT', start: 0, end: 10 }] });
  // 其余 5 万条与污染段完全不相交。
  let cursor = 10;
  for (let i = 0; i < fan; i++) {
    records.push({ kind: 'repack', batchId: `U${i}`, inputs: [
      { parentId: 'GIANT', start: cursor, end: cursor + chunk },
    ] });
    cursor += chunk;
  }
  const index = buildIndex(records);
  const stats: RecallStats = { visitedBatches: 0, scannedUsages: 0 };
  const result = recall(index, ['S'], stats);

  assert.deepEqual(result.get('S'), [{ start: 0, end: 10 }]);
  assert.deepEqual(result.get('GIANT'), [{ start: 0, end: 10 }]);
  assert.deepEqual(result.get('HIT'), [{ start: 0, end: 10 }]);
  assert.equal(result.size, 3);
  // 只访问受污染的 3 个批次，不扫描全部 5 万+ 历史记录。
  assert.equal(stats.visitedBatches, 3);
  // 二分定位后只检查与污染段相交的引用，不遍历 5 万条不相交引用。
  assert.ok(stats.scannedUsages <= 2, `scannedUsages=${stats.scannedUsages}`);
});

test('万亿级数量的混料：产出数量不同于投入数量', () => {
  const records: HistoryRecord[] = [
    { kind: 'receipt', batchId: 'A', quantity: 10 ** 12 },
    { kind: 'receipt', batchId: 'B', quantity: 10 ** 12 },
    { kind: 'mix', batchId: 'M', quantity: 7 * 10 ** 11, inputs: [
      { parentId: 'A', start: 5 * 10 ** 11, end: 5 * 10 ** 11 + 1 },
      { parentId: 'B', start: 0, end: 10 ** 12 },
    ] },
  ];
  const index = buildIndex(records);
  const stats: RecallStats = { visitedBatches: 0, scannedUsages: 0 };
  const result = recall(index, ['A'], stats);
  assert.deepEqual(result.get('A'), [{ start: 0, end: 10 ** 12 }]);
  assert.deepEqual(result.get('M'), [{ start: 0, end: 7 * 10 ** 11 }]);
  assert.equal(result.size, 2);
  assert.ok(stats.visitedBatches <= 2);
});

test('10 万批次、20 万条引用：建索引与查询随规模线性增长', () => {
  const n = 100_000;
  const records: HistoryRecord[] = [{ kind: 'receipt', batchId: 'B0', quantity: 10 }];
  for (let i = 1; i <= n; i++) {
    records.push({ kind: 'repack', batchId: `B${i}`, inputs: [
      { parentId: `B${i - 1}`, start: 0, end: 5 },
      { parentId: `B${i - 1}`, start: 5, end: 10 },
    ] });
  }
  const index = buildIndex(records);
  const stats: RecallStats = { visitedBatches: 0, scannedUsages: 0 };
  const result = recall(index, ['B0'], stats);
  assert.equal(result.size, n + 1);
  assert.deepEqual(result.get(`B${n}`), [{ start: 0, end: 10 }]);
  // 每个批次恰好处理一次、每条引用恰好检查一次：严格线性。
  assert.equal(stats.visitedBatches, n + 1);
  assert.equal(stats.scannedUsages, 2 * n);
});

test('查询只触及传播可达子图：无关分支不被访问', () => {
  // 两条互不相干的链各 1 万批次，召回其中一条的源头。
  const n = 10_000;
  const records: HistoryRecord[] = [
    { kind: 'receipt', batchId: 'P0', quantity: 10 },
    { kind: 'receipt', batchId: 'Q0', quantity: 10 },
  ];
  for (let i = 1; i <= n; i++) {
    records.push({ kind: 'repack', batchId: `P${i}`, inputs: [{ parentId: `P${i - 1}`, start: 0, end: 10 }] });
    records.push({ kind: 'repack', batchId: `Q${i}`, inputs: [{ parentId: `Q${i - 1}`, start: 0, end: 10 }] });
  }
  const index = buildIndex(records);
  const stats: RecallStats = { visitedBatches: 0, scannedUsages: 0 };
  const result = recall(index, ['P0'], stats);
  assert.equal(result.size, n + 1);
  assert.equal(stats.visitedBatches, n + 1);
  assert.ok(!result.has(`Q${n}`));
});
