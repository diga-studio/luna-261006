import { Range } from './types';

/**
 * 有序、不重叠、相邻已合并的区间集合（按 start 升序）。
 * 用扁平数组 [s0, e0, s1, e1, ...] 存储，避免逐单位展开。
 */
export type IntervalSet = number[];

export function createSet(): IntervalSet {
  return [];
}

/** 第一个满足 end_i >= value 的下标（在 ends 上二分）。 */
function lowerBoundEnds(set: IntervalSet, value: number): number {
  let lo = 0;
  let hi = set.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (set[2 * mid + 1]! >= value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 最后一个满足 start_i <= value 的下标；不存在时返回 -1。 */
function upperBoundStarts(set: IntervalSet, value: number): number {
  let lo = -1;
  let hi = set.length / 2 - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (set[2 * mid]! <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 向集合中插入区间 [start, end)，与现有区间合并（含相邻）。
 * 返回本次真正新增的、此前不在集合中的子区间（delta），按序且不重叠。
 */
export function insertInto(set: IntervalSet, start: number, end: number): Range[] {
  const first = lowerBoundEnds(set, start); // end_i >= start（重叠或左相邻）
  const last = upperBoundStarts(set, end); // start_i <= end（重叠或右相邻）

  const delta: Range[] = [];
  if (first > last) {
    // 与任何现有区间都不重叠也不相邻，直接插入。
    set.splice(2 * first, 0, start, end);
    delta.push({ start, end });
    return delta;
  }

  // 计算 delta：遍历被合并的现有区间之间的空隙。
  let cursor = start;
  for (let k = first; k <= last; k++) {
    const s = set[2 * k]!;
    const e = set[2 * k + 1]!;
    if (s > cursor) {
      delta.push({ start: cursor, end: Math.min(s, end) });
    }
    cursor = Math.max(cursor, e);
    if (cursor >= end) break;
  }
  if (cursor < end) {
    delta.push({ start: cursor, end });
  }

  const mergedStart = Math.min(start, set[2 * first]!);
  const mergedEnd = Math.max(end, set[2 * last + 1]!);
  set.splice(2 * first, 2 * (last - first + 1), mergedStart, mergedEnd);
  return delta;
}
