/** 半开区间 [start, end)，单位：UTC 纪元秒。 */
export interface Interval {
  start: number;
  end: number;
}

/** 将可能重复、交叠、乱序的区间合并为互不相交的有序区间。 */
export function unionIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.start <= last.end) {
      if (interval.end > last.end) {
        last.end = interval.end;
      }
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}
