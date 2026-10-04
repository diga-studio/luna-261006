import { TimeZone } from "./timezone.js";
import type { TimeInterval, WorkCalendar } from "./types.js";

/** 半开 UTC 区间 [start, end)，单位毫秒。 */
export interface UtcSegment {
  start: number;
  end: number;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

function floorToDay(civilMs: number): number {
  return Math.floor(civilMs / DAY_MS) * DAY_MS;
}

/** 本地历法毫秒 -> "YYYY-MM-DD"（历法毫秒按 UTC 解读）。 */
function dateKey(dayCivilMs: number): string {
  return new Date(dayCivilMs).toISOString().slice(0, 10);
}

/** 1970-01-01 是周四（weekday=4）。 */
function weekdayOf(dayCivilMs: number): number {
  const days = dayCivilMs / DAY_MS;
  return (((days + 4) % 7) + 7) % 7;
}

/** 求某个本地日期生效的工作区间（例外优先于每周安排）。 */
export function effectiveIntervals(
  calendar: WorkCalendar,
  localDateCivilMs: number,
): readonly TimeInterval[] {
  const day = floorToDay(localDateCivilMs);
  const exception = calendar.exceptions[dateKey(day)];
  if (exception !== undefined) return exception;
  return calendar.weekly[weekdayOf(day)] ?? [];
}

/**
 * 把一段本地历法区间 [startCivilMs, endCivilMs) 映射为 0~2 段 UTC 区间。
 * 夏令时跳过的本地时间被剔除；重复的本地时间两段都保留。
 */
export function localIntervalToUtcSegments(
  tz: TimeZone,
  startCivilMs: number,
  endCivilMs: number,
): UtcSegment[] {
  const start = skipGap(tz, startCivilMs);
  const end = skipGap(tz, endCivilMs);
  if (end <= start) return [];

  const points = new Set<number>();
  for (const t of tz.localToUtc(start)) points.add(t);
  for (const t of tz.localToUtc(end)) points.add(t);
  if (points.size === 0) return [];
  const sorted = [...points].sort((a, b) => a - b);
  for (const t of tz.transitionsBetween(sorted[0], sorted[sorted.length - 1])) {
    points.add(t);
  }
  const all = [...points].sort((a, b) => a - b);

  const segments: UtcSegment[] = [];
  for (let i = 0; i + 1 < all.length; i++) {
    const p = all[i];
    const q = all[i + 1];
    if (q <= p) continue;
    const mid = p + Math.floor((q - p) / 2);
    const local = tz.toLocalCivilMs(mid);
    if (local >= start && local < end) {
      const last = segments[segments.length - 1];
      if (last && last.end === p) last.end = q;
      else segments.push({ start: p, end: q });
    }
  }
  return segments;
}

/**
 * 若本地时刻落在夏令时跳过区间，返回跳过区间结束后的第一个有效本地时刻；
 * 否则原样返回。
 */
function skipGap(tz: TimeZone, localCivilMs: number): number {
  if (tz.localToUtc(localCivilMs).length > 0) return localCivilMs;
  const approx = tz.offsetAt(localCivilMs);
  const guess = localCivilMs - approx;
  const transitions = tz.transitionsBetween(
    guess - 4 * 3_600_000,
    guess + 4 * 3_600_000,
  );
  for (const t of transitions) {
    if (tz.toLocalCivilMs(t - 1) <= localCivilMs && localCivilMs < tz.toLocalCivilMs(t)) {
      return tz.toLocalCivilMs(t);
    }
  }
  throw new Error(`local time ${localCivilMs} is invalid but no gap found`);
}

/** 把单段工作区间规范化为本地历法毫秒区间 [start, end)。 */
function normalizeInterval(
  dayCivilMs: number,
  interval: TimeInterval,
): { start: number; end: number } {
  const start = dayCivilMs + interval.startMinutes * MINUTE_MS;
  const durationMin =
    interval.endMinutes === interval.startMinutes
      ? 1440
      : (interval.endMinutes - interval.startMinutes + 1440) % 1440;
  return { start, end: start + durationMin * MINUTE_MS };
}

/**
 * 生成覆盖 [fromUtc, toUtc) 的全部工作时段（UTC 毫秒，升序、重叠已合并、已裁剪）。
 */
export function workSegmentsBetween(
  calendar: WorkCalendar,
  fromUtc: number,
  toUtc: number,
): UtcSegment[] {
  if (toUtc <= fromUtc) return [];
  const tz = new TimeZone(calendar.timeZone);
  const firstDay = floorToDay(tz.toLocalCivilMs(fromUtc)) - DAY_MS;
  const lastDay = floorToDay(tz.toLocalCivilMs(toUtc));

  const raw: UtcSegment[] = [];
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    for (const interval of effectiveIntervals(calendar, day)) {
      const { start, end } = normalizeInterval(day, interval);
      for (const seg of localIntervalToUtcSegments(tz, start, end)) {
        raw.push(seg);
      }
    }
  }

  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: UtcSegment[] = [];
  for (const seg of raw) {
    const start = Math.max(seg.start, fromUtc);
    const end = Math.min(seg.end, toUtc);
    if (end <= start) continue;
    const last = merged[merged.length - 1];
    if (last && last.end >= start) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  return merged;
}
