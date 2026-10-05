import type { TimeRecord } from "./types.js";

/** Half-open interval [start, end) in UTC epoch seconds. */
export interface Interval {
  start: number;
  end: number;
}

/**
 * Merge a set of (possibly duplicated/overlapping) records into disjoint
 * effective-work intervals for one employee, sorted by start. Each covered
 * second is counted exactly once regardless of duplication or overlap.
 */
export function mergeEffectiveIntervals(records: TimeRecord[]): Interval[] {
  const sorted = records
    .filter((r) => r.endUtc > r.startUtc)
    .map((r) => ({ start: r.startUtc, end: r.endUtc }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}
