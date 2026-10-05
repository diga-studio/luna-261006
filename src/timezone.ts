/**
 * Time-zone helpers built on Intl. All "epoch minutes" are integer minutes
 * since the Unix epoch. "Local epoch minutes" treat a zone's wall clock as
 * if it were UTC, so local calendar arithmetic stays in integers.
 */

const MINUTE_MS = 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (fmt === undefined) {
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
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Offset of `timeZone` east of UTC, in minutes, at `utcMs`. */
export function offsetMinutesAt(timeZone: string, utcMs: number): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  // Modern zones (and every zone in 2020-2035) have whole-minute offsets.
  return Math.round((wallMs - utcMs) / MINUTE_MS);
}

/**
 * All offset-transition instants of `timeZone` inside [fromUtcMs, toUtcMs],
 * as UTC epoch minutes (the first minute carrying the new offset), ascending.
 */
export function transitionsBetween(
  timeZone: string,
  fromUtcMs: number,
  toUtcMs: number,
): number[] {
  const fromMin = Math.floor(fromUtcMs / MINUTE_MS);
  const toMin = Math.floor(toUtcMs / MINUTE_MS);
  const stepMin = 6 * 60; // transitions are never closer than this in practice
  const result: number[] = [];
  let prevMin = fromMin;
  let prevOffset = offsetMinutesAt(timeZone, prevMin * MINUTE_MS);
  for (let cur = fromMin + stepMin; cur <= toMin + stepMin; cur += stepMin) {
    const probe = Math.min(cur, toMin);
    const offset = offsetMinutesAt(timeZone, probe * MINUTE_MS);
    if (offset !== prevOffset) {
      // Binary search the first minute whose offset differs from prevOffset.
      let lo = prevMin; // old offset
      let hi = probe; // new offset
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (offsetMinutesAt(timeZone, mid * MINUTE_MS) === prevOffset) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      result.push(hi);
    }
    prevMin = probe;
    prevOffset = offset;
    if (probe === toMin) break;
  }
  return result;
}
