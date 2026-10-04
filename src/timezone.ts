import type { LocalDate, LocalTime, TimeZone, UtcInstant } from "./types.js";

export interface LocalDateTime {
  date: LocalDate;
  time: LocalTime;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

const formatterCache = new Map<TimeZone, Intl.DateTimeFormat>();

function getFormatter(timeZone: TimeZone): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function parseLocalDate(date: LocalDate): { y: number; m: number; d: number } {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`invalid local date: ${date}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export function parseLocalTime(time: LocalTime): { hh: number; mm: number } {
  const match = TIME_RE.exec(time);
  if (!match) throw new Error(`invalid local time: ${time}`);
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) throw new Error(`invalid local time: ${time}`);
  return { hh, mm };
}

function localDateTimeToMs(date: LocalDate, time: LocalTime): number {
  const { y, m, d } = parseLocalDate(date);
  const { hh, mm } = parseLocalTime(time);
  return Date.UTC(y, m - 1, d, hh, mm, 0, 0);
}

/** Local wall-clock reading (as ms on the UTC scale) at a UTC instant. */
function wallClockMsAt(timeZone: TimeZone, utcMs: number): number {
  const parts = getFormatter(timeZone).formatToParts(new Date(utcMs));
  const bag: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") bag[part.type] = Number(part.value);
  }
  return Date.UTC(bag["year"]!, bag["month"]! - 1, bag["day"]!, bag["hour"]!, bag["minute"]!, bag["second"]!);
}

/** Offset (local minus UTC) in ms at a UTC instant. */
function offsetMsAt(timeZone: TimeZone, utcMs: number): number {
  return wallClockMsAt(timeZone, utcMs) - utcMs;
}

/**
 * Resolve wall-clock `localMs` (expressed on the UTC scale) to UTC instants
 * whose formatted local reading equals it. Returns 0, 1 or 2 candidates.
 */
function resolveExact(timeZone: TimeZone, localMs: number): number[] {
  const candidates = new Set<number>();
  let utcMs = localMs - offsetMsAt(timeZone, localMs);
  for (let i = 0; i < 3; i += 1) {
    if (wallClockMsAt(timeZone, utcMs) === localMs) candidates.add(utcMs);
    const next = localMs - offsetMsAt(timeZone, utcMs);
    if (next === utcMs) break;
    utcMs = next;
  }
  return [...candidates];
}

export function localDateOf(timeZone: TimeZone, utcMs: number): LocalDate {
  const parts = getFormatter(timeZone).formatToParts(new Date(utcMs));
  const bag: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  return `${bag["year"]}-${bag["month"]}-${bag["day"]}`;
}

/**
 * Resolve a local wall-clock date+time in `timeZone` to a UTC instant.
 *
 * - Repeated local time (fall-back): returns the earlier UTC instant, even
 *   if that instant falls outside the owning version's validity range.
 * - Nonexistent local time (spring-forward gap): shifted forward by the
 *   actual offset change (e.g. 02:30 -> 03:30 for a one-hour gap, or by 30
 *   minutes for a half-hour gap), not to the end of the gap.
 * - Returns null when the shifted result lands on a different local date,
 *   which includes whole skipped dates (e.g. 2011-12-30 in Pacific/Apia).
 */
export function localToUtc(
  timeZone: TimeZone,
  date: LocalDate,
  time: LocalTime,
): UtcInstant | null {
  getFormatter(timeZone); // validate time zone eagerly
  const localMs = localDateTimeToMs(date, time);
  const exact = resolveExact(timeZone, localMs);
  if (exact.length > 0) {
    return new Date(Math.min(...exact)).toISOString();
  }
  // Gap: shift forward by the actual offset change across the transition.
  // The two guesses below straddle the transition (one on each side),
  // because the exact resolution above failed for both.
  const guessA = localMs - offsetMsAt(timeZone, localMs);
  const guessB = localMs - offsetMsAt(timeZone, guessA);
  const gapMs = Math.abs(offsetMsAt(timeZone, guessA) - offsetMsAt(timeZone, guessB));
  if (gapMs === 0) return null;
  const shifted = resolveExact(timeZone, localMs + gapMs);
  if (shifted.length === 0) return null;
  const utcMs = Math.min(...shifted);
  if (localDateOf(timeZone, utcMs) !== date) return null;
  return new Date(utcMs).toISOString();
}

/** Enumerate local dates in [startDate, endDate). */
export function enumerateLocalDates(
  startDate: LocalDate,
  endDate: LocalDate,
): LocalDate[] {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  const startMs = Date.UTC(start.y, start.m - 1, start.d);
  const endMs = Date.UTC(end.y, end.m - 1, end.d);
  const dates: LocalDate[] = [];
  for (let ms = startMs; ms < endMs; ms += 86_400_000) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}
