import type { WorkCalendar, WorkInterval } from "./types.js";
import { findOffsetTransitions, localParts } from "./tz.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MINUTES_PER_DAY = 1440;

/** 区间时长（分钟）：end<=start 表示跨午夜，相等表示 24 小时 */
function durationMinutes(iv: WorkInterval): number {
  const d = iv.endMinute - iv.startMinute;
  return d > 0 ? d : d + MINUTES_PER_DAY;
}

function validateInterval(iv: WorkInterval): void {
  for (const [name, v] of [["startMinute", iv.startMinute], ["endMinute", iv.endMinute]] as const) {
    if (!Number.isInteger(v) || v < 0 || v >= MINUTES_PER_DAY) {
      throw new RangeError(`invalid ${name}: ${v}`);
    }
  }
}

/** 本地日序号 -> "YYYY-MM-DD"（按本地民用日期，与机器时区无关） */
function dateKeyOf(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

/** 本地日序号 -> 星期几（0=周日 … 6=周六） */
function weekdayOf(dayNumber: number): number {
  return (((dayNumber % 7) + 7) % 7 + 4) % 7;
}

/**
 * 计算 [fromMs, toMs) 内“处于工作区间”的 UTC 时间段（已合并、升序、互不重叠）。
 * 夏令时跳过的本地时间不产生区间；重复的本地时间产生两段区间。
 */
export function workIntervalsUtc(
  calendar: WorkCalendar,
  fromMs: number,
  toMs: number,
): Array<[number, number]> {
  if (!(fromMs < toMs)) return [];
  const tz = calendar.timeZone;

  const exceptions = new Map<string, WorkInterval[]>();
  for (const ex of calendar.exceptions ?? []) {
    for (const iv of ex.intervals) validateInterval(iv);
    exceptions.set(ex.date, ex.intervals);
  }
  for (const day of calendar.weekly) {
    for (const iv of day) validateInterval(iv);
  }

  // 本地位置 p = 本地日序号 * 1440 + 当日分钟数。工作时间的“本地位置集合”
  // 与 UTC 一一对应（除夏令时跳变），先在本地位置空间合并，重叠只计一次。
  const firstDay = localParts(tz, fromMs).dayNumber - 1; // 前一天的跨午夜区间可能覆盖 fromMs
  const lastDay = localParts(tz, toMs - 1).dayNumber;
  const localRanges: Array<[number, number]> = [];
  for (let d = firstDay; d <= lastDay; d++) {
    const eff = exceptions.get(dateKeyOf(d)) ?? calendar.weekly[weekdayOf(d)];
    for (const iv of eff) {
      const p0 = d * MINUTES_PER_DAY + iv.startMinute;
      localRanges.push([p0, p0 + durationMinutes(iv)]);
    }
  }
  localRanges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of localRanges) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) {
      if (b > last[1]) last[1] = b;
    } else {
      merged.push([a, b]);
    }
  }
  if (merged.length === 0) return [];

  // 切成常量偏移段；段内 local = utc + offset，把本地位置区间映射回 UTC。
  const transitions = findOffsetTransitions(tz, fromMs, toMs);
  const boundaries = [fromMs, ...transitions, toMs];
  const result: Array<[number, number]> = [];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const segStart = boundaries[i];
    const segEnd = boundaries[i + 1];
    if (segStart >= segEnd) continue;
    const offset = offsetOfSegment(tz, segStart);
    // 每段独立二分定位：偏移变化会让同一本地区间在 UTC 上平移，
    // 不能跨段复用游标（否则回拨时段的第二段会被漏计）。
    let lo = 0, hi = merged.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (merged[mid][1] * MINUTE_MS - offset <= segStart) lo = mid + 1; else hi = mid;
    }
    for (let r = lo; r < merged.length; r++) {
      const [p0, p1] = merged[r];
      const u0 = p0 * MINUTE_MS - offset;
      const u1 = p1 * MINUTE_MS - offset;
      if (u0 >= segEnd) break;
      const a = Math.max(u0, segStart);
      const b = Math.min(u1, segEnd);
      if (a < b) pushMerged(result, a, b);
    }
  }
  return result;
}

function offsetOfSegment(timeZone: string, utcMs: number): number {
  // 段内偏移恒定，取段起点即可
  const lp = localParts(timeZone, utcMs);
  return lp.dayNumber * DAY_MS + lp.minuteOfDay * MINUTE_MS + lp.msOfMinute - utcMs;
}

function pushMerged(result: Array<[number, number]>, a: number, b: number): void {
  const last = result[result.length - 1];
  if (last && a <= last[1]) {
    if (b > last[1]) last[1] = b;
  } else {
    result.push([a, b]);
  }
}
