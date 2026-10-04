const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localPartsAt(timeZone: string, utcMs: number): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(utcMs));
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

/** Milliseconds to add to a UTC instant to get the local wall clock. */
export function offsetMsAt(timeZone: string, utcMs: number): number {
  const p = localPartsAt(timeZone, utcMs);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/** "YYYY-MM-DD" of the local date containing the instant. */
export function localDateKey(timeZone: string, utcMs: number): string {
  const p = localPartsAt(timeZone, utcMs);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

/** UTC instant of local midnight (00:00 wall) for the day containing `utcMs`. */
export function localMidnightUtc(timeZone: string, utcMs: number): number {
  const p = localPartsAt(timeZone, utcMs);
  const wallMidnight = Date.UTC(p.year, p.month - 1, p.day);
  let guess = wallMidnight - offsetMsAt(timeZone, utcMs);
  for (let i = 0; i < 4; i++) {
    const refined = wallMidnight - offsetMsAt(timeZone, guess);
    if (refined === guess) {
      break;
    }
    guess = refined;
  }
  return guess;
}
