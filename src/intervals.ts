/** 半开区间 [startMs, endMs)。 */
export interface Interval {
  startMs: number;
  endMs: number;
}

/** 计算一组区间的并集总长度（毫秒）。 */
export function unionLengthMs(intervals: readonly Interval[]): number {
  if (intervals.length === 0) {
    return 0;
  }
  const sorted = intervals
    .slice()
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let total = 0;
  let currentStart = sorted[0]!.startMs;
  let currentEnd = sorted[0]!.endMs;
  for (let i = 1; i < sorted.length; i += 1) {
    const interval = sorted[i]!;
    if (interval.startMs > currentEnd) {
      total += currentEnd - currentStart;
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
    } else if (interval.endMs > currentEnd) {
      currentEnd = interval.endMs;
    }
  }
  total += currentEnd - currentStart;
  return total;
}
