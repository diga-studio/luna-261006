import { offsetMinutesAt, transitionsBetween } from "./timezone.js";
import type { WeeklyWindow } from "./types.js";

const MINUTE_MS = 60_000;
const DAY_MIN = 24 * 60;
/** Length of a local week in minutes. */
export const WEEK_MIN = 7 * DAY_MIN;
/** 1970-01-04 was a Sunday; local epoch minute of week 0's Sunday 00:00. */
const FIRST_SUNDAY_MIN = 3 * DAY_MIN;
/** Largest IANA UTC offset magnitude (minutes) in 2020-2035. */
const MAX_OFFSET_MIN = 14 * 60;

/** Half-open UTC interval in epoch minutes: [startMin, endMin). */
export interface UtcInterval {
  readonly startMin: number;
  readonly endMin: number;
}

/**
 * Convert one local wall-clock interval [localStartMin, localEndMin) (local
 * epoch minutes) into the UTC epoch-minute intervals whose wall-clock reading
 * falls inside it. Spring-forward gaps contribute nothing; fall-back folds
 * contribute one interval per occurrence.
 */
export function localIntervalToUtc(
  timeZone: string,
  localStartMin: number,
  localEndMin: number,
): UtcInterval[] {
  const utcLo = localStartMin - MAX_OFFSET_MIN;
  const utcHi = localEndMin + MAX_OFFSET_MIN;
  const transitions = transitionsBetween(
    timeZone,
    utcLo * MINUTE_MS,
    utcHi * MINUTE_MS,
  );
  // Constant-offset segments covering [utcLo, utcHi].
  const bounds = [utcLo, ...transitions, utcHi];
  const result: UtcInterval[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const segStart = bounds[i]!;
    const segEnd = bounds[i + 1]!;
    if (segEnd <= segStart) continue;
    const offset = offsetMinutesAt(timeZone, segStart * MINUTE_MS);
    // Wall-clock minutes this UTC segment displays: [segStart+off, segEnd+off).
    const start = Math.max(localStartMin, segStart + offset);
    const end = Math.min(localEndMin, segEnd + offset);
    if (end > start) {
      result.push({ startMin: start - offset, endMin: end - offset });
    }
  }
  return result;
}

/** Sort by start and merge overlapping or touching intervals. */
export function mergeIntervals(intervals: readonly UtcInterval[]): UtcInterval[] {
  const sorted = [...intervals].sort((a, b) => a.startMin - b.startMin);
  const merged: UtcInterval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && iv.startMin <= last.endMin) {
      if (iv.endMin > last.endMin) {
        merged[merged.length - 1] = { startMin: last.startMin, endMin: iv.endMin };
      }
    } else {
      merged.push(iv);
    }
  }
  return merged;
}

/**
 * Expand weekly windows into merged, sorted UTC availability intervals
 * (epoch minutes) clipped to [fromUtcMin, toUtcMin). Overlapping and
 * touching intervals are merged. Windows repeat on the director's local
 * calendar, never on a fixed UTC offset.
 */
export function weeklyWindowsToUtcIntervals(
  timeZone: string,
  windows: readonly WeeklyWindow[],
  fromUtcMin: number,
  toUtcMin: number,
): UtcInterval[] {
  if (windows.length === 0 || toUtcMin <= fromUtcMin) return [];
  // Local wall-clock range that could map into the UTC range of interest.
  const localLo = fromUtcMin - MAX_OFFSET_MIN;
  const localHi = toUtcMin + MAX_OFFSET_MIN;
  const raw: UtcInterval[] = [];
  for (const win of windows) {
    const weekStartMin = win.startDay * DAY_MIN + win.startMinute;
    const durationMin = (win.endMinute - win.startMinute + DAY_MIN) % DAY_MIN;
    const localStart = weekStartMin;
    const localEnd = weekStartMin + durationMin;
    // Week indices whose occurrence [Sunday_k+localStart, +localEnd) can
    // intersect [localLo, localHi).
    const firstWeek = Math.ceil(
      (localLo - localEnd - FIRST_SUNDAY_MIN) / WEEK_MIN,
    );
    const lastWeek = Math.floor(
      (localHi - localStart - FIRST_SUNDAY_MIN) / WEEK_MIN,
    );
    for (let week = firstWeek; week <= lastWeek; week += 1) {
      const sunday = FIRST_SUNDAY_MIN + week * WEEK_MIN;
      const pieces = localIntervalToUtc(
        timeZone,
        sunday + localStart,
        sunday + localEnd,
      );
      for (const piece of pieces) {
        const startMin = Math.max(piece.startMin, fromUtcMin);
        const endMin = Math.min(piece.endMin, toUtcMin);
        if (endMin > startMin) raw.push({ startMin, endMin });
      }
    }
  }
  return mergeIntervals(raw);
}
