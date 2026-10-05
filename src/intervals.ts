import type { Interval } from './types.js';

/**
 * 将区间列表排序并合并重叠/相邻（端点相接）区间，返回新数组。
 * 输入不被修改。
 */
export function normalizeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .filter((iv) => iv.end > iv.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && iv.start <= last.end) {
      if (iv.end > last.end) {
        merged[merged.length - 1] = { start: last.start, end: iv.end };
      }
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}
