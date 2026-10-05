import { createSet, insertInto, IntervalSet } from './intervals';
import {
  BatchInfo,
  HistoryRecord,
  OutRef,
  Range,
  RecallIndex,
  RecallResult,
  RecallStats,
} from './types';

/** 接收全部历史记录，返回可重复查询的索引。 */
export function buildIndex(records: HistoryRecord[]): RecallIndex {
  const batches = new Map<string, BatchInfo>();
  const outRefs = new Map<string, OutRef[]>();

  for (const rec of records) {
    if (batches.has(rec.id)) {
      throw new Error(`duplicate batch id: ${rec.id}`);
    }
    let info: BatchInfo;
    if (rec.kind === 'intake') {
      info = { id: rec.id, kind: 'intake', qty: rec.qty, inputs: [] };
    } else if (rec.kind === 'repack') {
      let offset = 0;
      const inputs = rec.inputs.map((r) => {
        const len = r.end - r.start;
        const item = { parent: r.parent, start: r.start, end: r.end, offset };
        offset += len;
        return item;
      });
      info = { id: rec.id, kind: 'repack', qty: offset, inputs };
    } else {
      const inputs = rec.inputs.map((r) => ({
        parent: r.parent,
        start: r.start,
        end: r.end,
        offset: 0,
      }));
      info = { id: rec.id, kind: 'mix', qty: rec.qty, inputs };
    }
    batches.set(rec.id, info);
    info.inputs.forEach((inp, inputIndex) => {
      let arr = outRefs.get(inp.parent);
      if (!arr) {
        arr = [];
        outRefs.set(inp.parent, arr);
      }
      arr.push({ start: inp.start, end: inp.end, child: rec.id, inputIndex });
    });
  }

  // 同一父批次的取用区间互不重叠，按 start 排序后即可二分查找。
  for (const arr of outRefs.values()) {
    arr.sort((a, b) => a.start - b.start);
  }
  return { batches, outRefs };
}

/** 在按 start 排序且互不重叠的引用表中，找第一个 end > start 的下标。 */
function firstOverlap(refs: OutRef[], start: number): number {
  let lo = 0;
  let hi = refs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (refs[mid]!.end > start) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

interface WorkItem {
  id: string;
  pieces: Range[];
}

/**
 * 将 sourceIds 指定的原始入库批次全部视为受污染，
 * 返回所有受影响批次及各批次中恰好受影响的数量区间（含源批次）。
 *
 * 传播按“增量区间”进行：每个批次只把新到达的污染片段向下游推送一次，
 * 多次汇合的污染在批次本地的区间集合里合并，不按路径枚举。
 */
export function recall(
  index: RecallIndex,
  sourceIds: string[],
  stats?: RecallStats,
): RecallResult {
  const contaminated = new Map<string, IntervalSet>();
  const queue: WorkItem[] = [];
  let piecesPropagated = 0;
  let refSearches = 0;
  let refsVisited = 0;

  const addContamination = (id: string, pieces: Range[]): void => {
    const batch = index.batches.get(id);
    if (!batch) {
      throw new Error(`unknown batch id: ${id}`);
    }
    let set = contaminated.get(id);
    if (!set) {
      set = createSet();
      contaminated.set(id, set);
    }
    const fresh: Range[] = [];
    for (const p of pieces) {
      const delta = insertInto(set, p.start, p.end);
      for (const d of delta) fresh.push(d);
    }
    if (fresh.length > 0) {
      piecesPropagated += fresh.length;
      queue.push({ id, pieces: fresh });
    }
  };

  for (const id of sourceIds) {
    const batch = index.batches.get(id);
    if (!batch) {
      throw new Error(`unknown source batch id: ${id}`);
    }
    addContamination(id, [{ start: 0, end: batch.qty }]);
  }

  for (let head = 0; head < queue.length; head++) {
    const { id, pieces } = queue[head]!;
    const refs = index.outRefs.get(id);
    if (!refs || refs.length === 0) continue;
    for (const piece of pieces) {
      refSearches++;
      let k = firstOverlap(refs, piece.start);
      while (k < refs.length && refs[k]!.start < piece.end) {
        const ref = refs[k]!;
        k++;
        refsVisited++;
        const child = index.batches.get(ref.child)!;
        const inp = child.inputs[ref.inputIndex]!;
        const ovStart = Math.max(piece.start, ref.start);
        const ovEnd = Math.min(piece.end, ref.end);
        if (child.kind === 'repack') {
          // 搬运映射：父区间平移到子批次的拼接偏移处，保持内部顺序。
          addContamination(child.id, [
            {
              start: inp.offset + (ovStart - inp.start),
              end: inp.offset + (ovEnd - inp.start),
            },
          ]);
        } else {
          // 混料：任一实际投用区间含污染，产出全部受污染。
          addContamination(child.id, [{ start: 0, end: child.qty }]);
        }
      }
    }
  }

  const result: RecallResult = new Map();
  for (const [id, set] of contaminated) {
    const ranges: Range[] = [];
    for (let i = 0; i < set.length; i += 2) {
      ranges.push({ start: set[i]!, end: set[i + 1]! });
    }
    result.set(id, ranges);
  }

  if (stats) {
    stats.batchesTouched = contaminated.size;
    stats.piecesPropagated = piecesPropagated;
    stats.refSearches = refSearches;
    stats.refsVisited = refsVisited;
  }
  return result;
}
