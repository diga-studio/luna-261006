import type { RecallIndex } from './index-builder.js';
import { normalizeIntervals } from './intervals.js';
import type { Interval, RecallResult } from './types.js';

/** 按拓扑序号取最小值的二叉堆，保证父批次先于子批次处理。 */
class RankHeap {
  private readonly ids: string[] = [];
  private readonly ranks: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: string, rank: number): void {
    this.ids.push(id);
    this.ranks.push(rank);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.ranks[parent]! <= this.ranks[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): string | undefined {
    const n = this.ids.length;
    if (n === 0) return undefined;
    const top = this.ids[0]!;
    this.swap(0, n - 1);
    this.ids.pop();
    this.ranks.pop();
    let i = 0;
    const m = this.ids.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < m && this.ranks[left]! < this.ranks[smallest]!) smallest = left;
      if (right < m && this.ranks[right]! < this.ranks[smallest]!) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const ti = this.ids[a]!;
    this.ids[a] = this.ids[b]!;
    this.ids[b] = ti;
    const tr = this.ranks[a]!;
    this.ranks[a] = this.ranks[b]!;
    this.ranks[b] = tr;
  }
}

/**
 * 将 sourceIds 对应批次全部视为受污染，返回所有受影响批次（含源批次）
 * 及各自的受影响区间。区间有序、不重叠、相邻已合并。
 *
 * 只访问受污染传播可达的批次，并按拓扑序每个批次处理一次：
 * 多条传播链汇合时区间先合并再下传，工作量与路径条数无关。
 */
export function recall(
  index: RecallIndex,
  sourceIds: readonly string[],
  stats?: RecallStats,
): RecallResult {
  const { batches } = index;
  const pending = new Map<string, Interval[]>();
  const heap = new RankHeap();
  const queued = new Set<string>();
  const done = new Set<string>();

  const addIntervals = (id: string, ivs: readonly Interval[]): void => {
    let list = pending.get(id);
    if (list === undefined) {
      list = [];
      pending.set(id, list);
    }
    for (const iv of ivs) list.push(iv);
    if (!done.has(id) && !queued.has(id)) {
      queued.add(id);
      heap.push(id, batches.get(id)!.rank);
    }
  };

  for (const id of sourceIds) {
    const info = batches.get(id);
    if (info === undefined) continue;
    addIntervals(id, [{ start: 0, end: info.quantity }]);
  }

  const result = new Map<string, readonly Interval[]>();

  for (;;) {
    const id = heap.pop();
    if (id === undefined) break;
    queued.delete(id);
    if (done.has(id)) continue;
    done.add(id);
    if (stats !== undefined) stats.visitedBatches += 1;

    const info = batches.get(id)!;
    const merged = normalizeIntervals(pending.get(id)!);
    if (merged.length === 0) continue;
    result.set(id, merged);

    const usages = info.usages;
    for (const iv of merged) {
      // 二分找到第一个 pEnd > iv.start 的取用引用，只遍历重叠部分。
      let lo = 0;
      let hi = usages.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (usages[mid]!.pEnd <= iv.start) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < usages.length; i++) {
        const u = usages[i]!;
        if (u.pStart >= iv.end) break;
        if (stats !== undefined) stats.scannedUsages += 1;
        const child = batches.get(u.childId)!;
        if (done.has(u.childId)) continue;
        if (u.isMix) {
          addIntervals(u.childId, [{ start: 0, end: child.quantity }]);
        } else {
          const oStart = Math.max(u.pStart, iv.start);
          const oEnd = Math.min(u.pEnd, iv.end);
          addIntervals(u.childId, [{
            start: u.childStart + (oStart - u.pStart),
            end: u.childStart + (oEnd - u.pStart),
          }]);
        }
      }
    }
  }

  return result;
}

/** 可选的查询开销统计，用于测试验证无全量扫描/路径爆炸。 */
export interface RecallStats {
  /** 实际处理的受污染批次数。 */
  visitedBatches: number;
  /** 实际检查的取用引用条数（二分跳过的不计）。 */
  scannedUsages: number;
}
