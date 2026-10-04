import { BusinessCalendar, TimeWindow } from "./types";
import { localDateKey, localMidnightUtc, localPartsAt, offsetMsAt } from "./timezone";

export interface Interval {
  start: number;
  end: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function parseWindowMinutes(w: TimeWindow): [number, number] {
  const [sh, sm] = w.start.split(":").map(Number);
  const [eh, em] = w.end.split(":").map(Number);
  return [sh * 60 + sm, eh * 60 + em];
}

function windowsForLocalDate(
  calendar: BusinessCalendar,
  dateKey: string,
  weekday: number
): TimeWindow[] {
  if (calendar.exceptions && Object.prototype.hasOwnProperty.call(calendar.exceptions, dateKey)) {
    return calendar.exceptions[dateKey];
  }
  return calendar.weekly[weekday] ?? [];
}

interface OffsetSegment extends Interval {
  offset: number;
}

function findTransition(timeZone: string, lo: number, hi: number, oldOffset: number): number {
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMsAt(timeZone, mid) === oldOffset) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

/** Split [start, end) into maximal real-time segments with a constant UTC offset. */
function offsetSegments(timeZone: string, start: number, end: number): OffsetSegment[] {
  const segments: OffsetSegment[] = [];
  const step = 10 * MINUTE_MS;
  let segStart = start;
  let offset = offsetMsAt(timeZone, start);
  for (let t = start + step; t < end; t += step) {
    const o = offsetMsAt(timeZone, t);
    if (o !== offset) {
      const transition = findTransition(timeZone, t - step, t, offset);
      segments.push({ start: segStart, end: transition, offset });
      segStart = transition;
      offset = o;
    }
  }
  segments.push({ start: segStart, end, offset });
  return segments;
}

/**
 * Merged, sorted, disjoint real-time intervals of business time within [from, to).
 * Repeated wall-clock ranges (DST fall-back) count once per real occurrence.
 */
export function businessIntervals(
  calendar: BusinessCalendar,
  from: number,
  to: number
): Interval[] {
  const raw: Interval[] = [];
  if (to <= from) {
    return raw;
  }
  const tz = calendar.timeZone;
  let dayStart = localMidnightUtc(tz, from);
  while (dayStart < to) {
    const dayEnd = localMidnightUtc(tz, dayStart + 25 * HOUR_MS + MINUTE_MS);
    const parts = localPartsAt(tz, dayStart);
    const wallDay = Date.UTC(parts.year, parts.month - 1, parts.day);
    const weekday = new Date(wallDay).getUTCDay();
    const windows = windowsForLocalDate(calendar, localDateKey(tz, dayStart), weekday);
    if (windows.length > 0) {
      for (const seg of offsetSegments(tz, dayStart, dayEnd)) {
        for (const w of windows) {
          const [startMin, endMin] = parseWindowMinutes(w);
          const start = Math.max(wallDay + startMin * MINUTE_MS - seg.offset, seg.start);
          const end = Math.min(wallDay + endMin * MINUTE_MS - seg.offset, seg.end);
          if (end > start) {
            raw.push({ start, end });
          }
        }
      }
    }
    dayStart = dayEnd;
  }
  raw.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of raw) {
    const start = Math.max(iv.start, from);
    const end = Math.min(iv.end, to);
    if (end <= start) {
      continue;
    }
    const last = merged[merged.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      merged.push({ start, end });
    }
  }
  return merged;
}
