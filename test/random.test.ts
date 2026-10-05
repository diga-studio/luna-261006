import { test } from 'node:test';
import { deepEqual } from 'node:assert/strict';
import { buildIndex, recall } from '../src/recall';
import { HistoryRecord, InputRef, Range, RecallResult } from '../src/types';
import { referenceRecall } from './reference-model';

/** mulberry32 确定性伪随机数发生器。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Generated {
  records: HistoryRecord[];
  intakeIds: string[];
}

/** 生成随机合法历史：父批次存在、依赖无环、区间在界内、同一父批次取用互不重叠。 */
function generateHistory(rand: () => number, batchCount: number): Generated {
  const records: HistoryRecord[] = [];
  const intakeIds: string[] = [];
  const qtyOf = new Map<string, number>();
  const usedByParent = new Map<string, Range[]>();

  const allocInterval = (parent: string): InputRef | null => {
    const qty = qtyOf.get(parent)!;
    const used = usedByParent.get(parent)!;
    for (let attempt = 0; attempt < 30; attempt++) {
      const maxLen = Math.min(qty, 8);
      const len = 1 + Math.floor(rand() * maxLen);
      const start = Math.floor(rand() * (qty - len + 1));
      const end = start + len;
      if (used.every((u) => u.end <= start || u.start >= end)) {
        used.push({ start, end });
        return { parent, start, end };
      }
    }
    return null;
  };

  for (let i = 0; i < batchCount; i++) {
    const id = `B${i}`;
    const existing = [...qtyOf.keys()];
    const roll = rand();
    if (existing.length === 0 || roll < 0.3) {
      const qty = 1 + Math.floor(rand() * 24);
      records.push({ kind: 'intake', id, qty });
      qtyOf.set(id, qty);
      usedByParent.set(id, []);
      intakeIds.push(id);
      continue;
    }
    const inputCount = 1 + Math.floor(rand() * Math.min(3, existing.length));
    const parents = [...existing].sort(() => rand() - 0.5).slice(0, inputCount);
    const inputs: InputRef[] = [];
    for (const p of parents) {
      const ref = allocInterval(p);
      if (ref) inputs.push(ref);
    }
    if (inputs.length === 0) {
      const qty = 1 + Math.floor(rand() * 24);
      records.push({ kind: 'intake', id, qty });
      qtyOf.set(id, qty);
      usedByParent.set(id, []);
      intakeIds.push(id);
      continue;
    }
    if (roll < 0.65) {
      records.push({ kind: 'repack', id, inputs });
      qtyOf.set(id, inputs.reduce((a, r) => a + (r.end - r.start), 0));
    } else {
      records.push({ kind: 'mix', id, inputs, qty: 1 + Math.floor(rand() * 24) });
      qtyOf.set(id, records[records.length - 1]!.kind === 'mix' ? (records[records.length - 1] as { qty: number }).qty : 0);
    }
    usedByParent.set(id, []);
  }
  // 打乱记录顺序：buildIndex 不得依赖记录按依赖序给出。
  const shuffled = [...records].sort(() => rand() - 0.5);
  return { records: shuffled, intakeIds };
}

function toPlain(result: RecallResult | Map<string, Range[]>): Record<string, [number, number][]> {
  const obj: Record<string, [number, number][]> = {};
  for (const [id, ranges] of result) {
    if (ranges.length === 0) continue;
    obj[id] = ranges.map((r) => [r.start, r.end]);
  }
  return obj;
}

function unionResults(results: Array<RecallResult | Map<string, Range[]>>): Record<string, [number, number][]> {
  const merged = new Map<string, Range[]>();
  for (const res of results) {
    for (const [id, ranges] of res) {
      let arr = merged.get(id);
      if (!arr) {
        arr = [];
        merged.set(id, arr);
      }
      arr.push(...ranges);
    }
  }
  const obj: Record<string, [number, number][]> = {};
  for (const [id, ranges] of merged) {
    ranges.sort((a, b) => a.start - b.start);
    const out: [number, number][] = [];
    for (const r of ranges) {
      const last = out[out.length - 1];
      if (last && last[1] >= r.start) last[1] = Math.max(last[1], r.end);
      else out.push([r.start, r.end]);
    }
    obj[id] = out;
  }
  return obj;
}

test('随机小历史：与逐单位参考模型一致（300 组种子 × 多组召回源）', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rand = mulberry32(seed);
    const { records, intakeIds } = generateHistory(rand, 40);
    const index = buildIndex(records);

    const sourceSets: string[][] = [];
    // 多个召回源
    sourceSets.push([...intakeIds].sort(() => rand() - 0.5).slice(0, 3));
    sourceSets.push([...intakeIds].sort(() => rand() - 0.5).slice(0, 1));
    sourceSets.push(intakeIds); // 全部源

    for (const sources of sourceSets) {
      if (sources.length === 0) continue;
      const expected = toPlain(referenceRecall(records, sources));
      const actual = toPlain(recall(index, sources));
      deepEqual(actual, expected, `seed=${seed} sources=${sources.join(',')}`);

      // 性质：多源结果 == 分别查询后逐批次取并集
      const singles = sources.map((s) => recall(index, [s]));
      deepEqual(
        toPlain(recall(index, sources)),
        unionResults(singles),
        `union property seed=${seed}`,
      );
    }
  }
});

test('空交集：召回源没有任何下游引用时，结果只有源批次本身', () => {
  const records: HistoryRecord[] = [
    { kind: 'intake', id: 'lonely', qty: 10 },
    { kind: 'intake', id: 'used', qty: 10 },
    { kind: 'repack', id: 'child', inputs: [{ parent: 'used', start: 0, end: 5 }] },
  ];
  const index = buildIndex(records);
  deepEqual(toPlain(recall(index, ['lonely'])), { lonely: [[0, 10]] });
});

test('端点恰好相接：两个源的污染在子批次中相邻，必须合并为一个区间', () => {
  const records: HistoryRecord[] = [
    { kind: 'intake', id: 's1', qty: 10 },
    { kind: 'intake', id: 's2', qty: 10 },
    {
      kind: 'repack',
      id: 'joined',
      inputs: [
        { parent: 's1', start: 2, end: 6 }, // → joined[0,4)
        { parent: 's2', start: 3, end: 7 }, // → joined[4,8)
      ],
    },
  ];
  const index = buildIndex(records);
  deepEqual(toPlain(recall(index, ['s1', 's2'])), {
    s1: [[0, 10]],
    s2: [[0, 10]],
    joined: [[0, 8]], // [0,4) 与 [4,8) 相邻 → 合并
  });
});
