import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildIndex, recall } from '../src/index.js';
import type { HistoryRecord, Interval } from '../src/index.js';

/** 确定性伪随机数生成器。 */
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
  creationOrder: HistoryRecord[];
  receiptIds: string[];
}

/** 生成随机合法历史：父批次取用区间互不重叠，区间均在界内。 */
function generate(rand: () => number, batchCount: number): Generated {
  const records: HistoryRecord[] = [];
  const receiptIds: string[] = [];
  const quantities = new Map<string, number>();
  const usedBy = new Map<string, Interval[]>();
  const ids: string[] = [];

  const alloc = (parentId: string, len: number): Interval | null => {
    const q = quantities.get(parentId)!;
    const used = (usedBy.get(parentId) ?? []).slice().sort((a, b) => a.start - b.start);
    const gaps: Interval[] = [];
    let cursor = 0;
    for (const u of used) {
      if (u.start > cursor) gaps.push({ start: cursor, end: u.start });
      cursor = Math.max(cursor, u.end);
    }
    if (cursor < q) gaps.push({ start: cursor, end: q });
    const fit = gaps.filter((g) => g.end - g.start >= len);
    if (fit.length === 0) return null;
    const gap = fit[Math.floor(rand() * fit.length)]!;
    const slack = gap.end - gap.start - len;
    const start = gap.start + Math.floor(rand() * (slack + 1));
    const iv = { start, end: start + len };
    (usedBy.get(parentId) ?? usedBy.set(parentId, []).get(parentId)!).push(iv);
    return iv;
  };

  for (let i = 0; i < batchCount; i++) {
    const id = `B${i}`;
    const roll = rand();
    if (i === 0 || roll < 0.35) {
      const quantity = 1 + Math.floor(rand() * 30);
      records.push({ kind: 'receipt', batchId: id, quantity });
      quantities.set(id, quantity);
      receiptIds.push(id);
    } else {
      const inputCount = 1 + Math.floor(rand() * 3);
      const inputs: { parentId: string; start: number; end: number }[] = [];
      for (let k = 0; k < inputCount; k++) {
        const parentId = ids[Math.floor(rand() * ids.length)]!;
        const len = 1 + Math.floor(rand() * 8);
        const iv = alloc(parentId, len);
        if (iv !== null) inputs.push({ parentId, start: iv.start, end: iv.end });
      }
      if (inputs.length === 0) {
        const quantity = 1 + Math.floor(rand() * 30);
        records.push({ kind: 'receipt', batchId: id, quantity });
        quantities.set(id, quantity);
        receiptIds.push(id);
        ids.push(id);
        continue;
      }
      if (roll < 0.7) {
        records.push({ kind: 'repack', batchId: id, inputs });
        quantities.set(id, inputs.reduce((s, x) => s + (x.end - x.start), 0));
      } else {
        records.push({ kind: 'mix', batchId: id, quantity: 1 + Math.floor(rand() * 30), inputs });
        quantities.set(id, (records[records.length - 1] as { quantity: number }).quantity);
      }
    }
    ids.push(id);
  }

  // 打乱记录顺序，验证 buildIndex 不依赖依赖顺序。
  const shuffled = records.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }
  return { records: shuffled, creationOrder: records, receiptIds };
}

/** 独立逐单位参考模型：按创建顺序逐单位传播污染。 */
function modelRecall(gen: Generated, sourceIds: readonly string[]): Map<string, Interval[]> {
  const dirty = new Map<string, boolean[]>();
  const quantities = new Map<string, number>();
  const ensure = (id: string, q: number): boolean[] => {
    let arr = dirty.get(id);
    if (arr === undefined) {
      arr = new Array<boolean>(q).fill(false);
      dirty.set(id, arr);
    }
    return arr;
  };
  for (const rec of gen.creationOrder) {
    if (rec.kind === 'receipt') {
      quantities.set(rec.batchId, rec.quantity);
      ensure(rec.batchId, rec.quantity);
    } else if (rec.kind === 'repack') {
      const arr: boolean[] = [];
      for (const input of rec.inputs) {
        const parent = dirty.get(input.parentId)!;
        for (let p = input.start; p < input.end; p++) arr.push(parent[p]!);
      }
      quantities.set(rec.batchId, arr.length);
      dirty.set(rec.batchId, arr);
    } else {
      let hit = false;
      for (const input of rec.inputs) {
        const parent = dirty.get(input.parentId)!;
        for (let p = input.start; p < input.end; p++) {
          if (parent[p]) { hit = true; break; }
        }
        if (hit) break;
      }
      quantities.set(rec.batchId, rec.quantity);
      dirty.set(rec.batchId, new Array<boolean>(rec.quantity).fill(hit));
    }
  }
  for (const id of sourceIds) {
    const arr = dirty.get(id);
    if (arr !== undefined) arr.fill(true);
  }
  // 源批次在创建后才标记，需要重新传播：简单起见重跑一次。
  if (sourceIds.length > 0) {
    for (const rec of gen.creationOrder) {
      if (rec.kind === 'repack') {
        const arr: boolean[] = [];
        for (const input of rec.inputs) {
          const parent = dirty.get(input.parentId)!;
          for (let p = input.start; p < input.end; p++) arr.push(parent[p]!);
        }
        dirty.set(rec.batchId, arr);
      } else if (rec.kind === 'mix') {
        let hit = false;
        for (const input of rec.inputs) {
          const parent = dirty.get(input.parentId)!;
          for (let p = input.start; p < input.end; p++) {
            if (parent[p]) { hit = true; break; }
          }
          if (hit) break;
        }
        dirty.set(rec.batchId, new Array<boolean>(rec.quantity).fill(hit));
      }
    }
  }
  const result = new Map<string, Interval[]>();
  for (const [id, arr] of dirty) {
    const ivs: Interval[] = [];
    let start = -1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && start < 0) start = i;
      if (!arr[i] && start >= 0) {
        ivs.push({ start, end: i });
        start = -1;
      }
    }
    if (start >= 0) ivs.push({ start, end: arr.length });
    if (ivs.length > 0) result.set(id, ivs);
  }
  return result;
}

function toPlain(result: ReadonlyMap<string, readonly Interval[]>): Record<string, Interval[]> {
  const obj: Record<string, Interval[]> = {};
  for (const [id, ivs] of result) {
    obj[id] = ivs.map((iv) => ({ start: iv.start, end: iv.end }));
  }
  return obj;
}

test('随机小历史：与逐单位参考模型一致（多源、空交集、端点相接）', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rand = mulberry32(seed);
    const gen = generate(rand, 60);
    const index = buildIndex(gen.records);
    const sourceCount = 1 + Math.floor(rand() * 3);
    const sources: string[] = [];
    for (let k = 0; k < sourceCount; k++) {
      sources.push(gen.receiptIds[Math.floor(rand() * gen.receiptIds.length)]!);
    }
    const expected = modelRecall(gen, sources);
    const actual = recall(index, sources);
    assert.deepEqual(toPlain(actual), toPlain(expected), `seed=${seed} sources=${sources}`);

    // 多源结果等于分别查询的逐批次区间并集。
    const union = new Map<string, Interval[]>();
    for (const s of new Set(sources)) {
      for (const [id, ivs] of recall(index, [s])) {
        union.set(id, [...(union.get(id) ?? []), ...ivs.map((iv) => ({ ...iv }))]);
      }
    }
    const merged = new Map<string, Interval[]>();
    for (const [id, ivs] of union) {
      const sorted = ivs.sort((a, b) => a.start - b.start);
      const out: Interval[] = [];
      for (const iv of sorted) {
        const last = out[out.length - 1];
        if (last && iv.start <= last.end) {
          out[out.length - 1] = { start: last.start, end: Math.max(last.end, iv.end) };
        } else {
          out.push(iv);
        }
      }
      merged.set(id, out);
    }
    assert.deepEqual(toPlain(actual), toPlain(merged), `union seed=${seed}`);
  }
});

test('端点恰好相接的区间被合并为一段', () => {
  const records: HistoryRecord[] = [
    { kind: 'receipt', batchId: 'A', quantity: 5 },
    { kind: 'receipt', batchId: 'B', quantity: 5 },
    { kind: 'repack', batchId: 'C', inputs: [
      { parentId: 'A', start: 0, end: 5 },
      { parentId: 'B', start: 0, end: 5 },
    ] },
  ];
  const index = buildIndex(records);
  const result = recall(index, ['A', 'B']);
  assert.deepEqual(result.get('C'), [{ start: 0, end: 10 }]);
});

test('空交集：互不相干的源只召回自身链路', () => {
  const records: HistoryRecord[] = [
    { kind: 'receipt', batchId: 'A', quantity: 10 },
    { kind: 'receipt', batchId: 'B', quantity: 10 },
    { kind: 'repack', batchId: 'C', inputs: [{ parentId: 'A', start: 0, end: 4 }] },
    { kind: 'repack', batchId: 'D', inputs: [{ parentId: 'B', start: 6, end: 10 }] },
  ];
  const index = buildIndex(records);
  const result = recall(index, ['A', 'B']);
  assert.deepEqual(toPlain(result), {
    A: [{ start: 0, end: 10 }],
    B: [{ start: 0, end: 10 }],
    C: [{ start: 0, end: 4 }],
    D: [{ start: 0, end: 4 }],
  });
});
