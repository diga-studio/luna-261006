import { test } from 'node:test';
import { deepEqual, ok } from 'node:assert/strict';
import { buildIndex, recall } from '../src/recall';
import { HistoryRecord, RecallStats } from '../src/types';

const TRILLION = 1_000_000_000_000;

function freshStats(): RecallStats {
  return { batchesTouched: 0, piecesPropagated: 0, refSearches: 0, refsVisited: 0 };
}

test('万亿级数量：长链搬运不逐单位展开，区间保持精确', () => {
  const records: HistoryRecord[] = [{ kind: 'intake', id: 'S', qty: TRILLION }];
  const CHAIN = 2000;
  const TRIM = 1_000_000;
  let qty = TRILLION;
  for (let i = 0; i < CHAIN; i++) {
    const parent = i === 0 ? 'S' : `R${i - 1}`;
    records.push({
      kind: 'repack',
      id: `R${i}`,
      inputs: [{ parent, start: TRIM, end: qty - TRIM }],
    });
    qty -= 2 * TRIM;
  }
  const index = buildIndex(records);
  const stats = freshStats();
  const result = recall(index, ['S'], stats);

  // 源全污染，每一环取用的子区间也全污染：末环节区间为 [0, 末批数量)，不展开 1e12 个单位
  deepEqual(result.get(`R${CHAIN - 1}`), [{ start: 0, end: qty }]);
  // 每批恰好 1 个污染片段：工作量与批次规模成正比，与实物数量无关
  deepEqual(stats, {
    batchesTouched: CHAIN + 1,
    piecesPropagated: CHAIN + 1,
    refSearches: CHAIN,
    refsVisited: CHAIN,
  });
});

test('多轮拆分再汇合：路径数指数增长，传播工作量保持线性', () => {
  // 每轮：P -> X=P[0,m), Y=P[m,2m) -> P'=X+Y 重新汇合。
  // 源到第 L 轮的路径数为 2^L，逐路径枚举必然爆炸。
  const L = 60;
  const m = 500_000_000_000; // 单批 2m = 1e12，万亿级
  const records: HistoryRecord[] = [{ kind: 'intake', id: 'P0', qty: 2 * m }];
  for (let i = 0; i < L; i++) {
    records.push(
      { kind: 'repack', id: `X${i}`, inputs: [{ parent: `P${i}`, start: 0, end: m }] },
      { kind: 'repack', id: `Y${i}`, inputs: [{ parent: `P${i}`, start: m, end: 2 * m }] },
      {
        kind: 'repack',
        id: `P${i + 1}`,
        inputs: [
          { parent: `X${i}`, start: 0, end: m },
          { parent: `Y${i}`, start: 0, end: m },
        ],
      },
    );
  }
  const index = buildIndex(records);
  const stats = freshStats();
  const result = recall(index, ['P0'], stats);

  // 汇合后污染在每一层重新合并为完整区间
  deepEqual(result.get(`P${L}`), [{ start: 0, end: 2 * m }]);
  // 工作量随层数线性增长（每轮常数个片段），而不是 2^60 条路径
  ok(stats.piecesPropagated <= 4 * L + 1, `pieces=${stats.piecesPropagated}`);
  ok(stats.refsVisited <= 4 * L, `refs=${stats.refsVisited}`);
  ok(stats.batchesTouched === 3 * L + 1, `batches=${stats.batchesTouched}`);
});

test('巨型拼箱中的微小污染：二分跳过不相干的海量取用引用', () => {
  // G 由 F 的绝大部分与源 S 的 10 个单位拼成；G 有 5 万条互不相交的后续取用，
  // 只有最后一条落在受污染区域。
  const FAN = 50_000;
  const records: HistoryRecord[] = [
    { kind: 'intake', id: 'F', qty: TRILLION - 10 },
    { kind: 'intake', id: 'S', qty: 10 },
    {
      kind: 'repack',
      id: 'G',
      inputs: [
        { parent: 'F', start: 0, end: TRILLION - 10 },
        { parent: 'S', start: 0, end: 10 },
      ],
    },
  ];
  for (let i = 0; i < FAN; i++) {
    records.push({
      kind: 'repack',
      id: `C${i}`,
      inputs: [{ parent: 'G', start: i * 20_000, end: i * 20_000 + 1_000 }],
    });
  }
  records.push({
    kind: 'repack',
    id: 'Clast',
    inputs: [{ parent: 'G', start: TRILLION - 10, end: TRILLION }],
  });
  // 再混入 10 万个与传播无关的批次，验证查询不做全量扫描
  for (let i = 0; i < 100_000; i++) {
    records.push({ kind: 'intake', id: `noise${i}`, qty: 1 });
  }

  const index = buildIndex(records);
  const stats = freshStats();
  const result = recall(index, ['S'], stats);

  // 精确结果：只有 S、G 的尾部 10 个单位、以及 Clast 受影响
  deepEqual(result.get('S'), [{ start: 0, end: 10 }]);
  deepEqual(result.get('G'), [{ start: TRILLION - 10, end: TRILLION }]);
  deepEqual(result.get('Clast'), [{ start: 0, end: 10 }]);
  deepEqual(result.size, 3);

  // 5 万条引用中只命中 1 条；二分查找次数等于污染片段数，不是引用总数
  deepEqual(stats, {
    batchesTouched: 3,
    piecesPropagated: 3,
    refSearches: 2, // S 的 1 个片段 + G 的 1 个片段
    refsVisited: 2, // S→G、G→Clast
  });
});

test('混料只被实际投用区间触发：同一父批次上大量未投用污染不扩散', () => {
  // 源 S 全污染；M 只投用 F（未污染）的一段；K 投用 S 的一小段。
  const records: HistoryRecord[] = [
    { kind: 'intake', id: 'S', qty: TRILLION },
    { kind: 'intake', id: 'F', qty: 100 },
    {
      kind: 'mix',
      id: 'M',
      inputs: [{ parent: 'F', start: 10, end: 20 }],
      qty: 5,
    },
    {
      kind: 'mix',
      id: 'K',
      inputs: [
        { parent: 'F', start: 30, end: 40 },
        { parent: 'S', start: TRILLION - 5, end: TRILLION },
      ],
      qty: 7,
    },
  ];
  const index = buildIndex(records);
  const result = recall(index, ['S']);
  deepEqual(result.get('S'), [{ start: 0, end: TRILLION }]);
  deepEqual(result.get('K'), [{ start: 0, end: 7 }]); // 投用段含污染 → 全部召回
  ok(!result.has('M')); // 未投用 S，不受污染
  ok(!result.has('F'));
});
