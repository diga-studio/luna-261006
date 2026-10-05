/** Timezone helpers for the fixed enterprise zone "America/New_York". */

export const ENTERPRISE_TIMEZONE = "America/New_York";

const SECONDS_PER_DAY = 86400;

const dtf = new Intl.DateTimeFormat("en-US", {
  timeZone: ENTERPRISE_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localPartsAt(utcSec: number): LocalParts {
  const parts = dtf.formatToParts(new Date(utcSec * 1000));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`missing part ${type}`);
    return Number(p.value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Seconds to add to a UTC instant to obtain the local wall-clock reading. */
function utcOffsetAt(utcSec: number): number {
  const p = localPartsAt(utcSec);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return wallAsUtc - utcSec;
}

function parseLocalDate(localDate: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error(`invalid local date: ${localDate}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** UTC epoch second of local midnight for a local date "YYYY-MM-DD". */
export function localMidnightToUtc(localDate: string): number {
  const { y, m, d } = parseLocalDate(localDate);
  const wallMidnight = Date.UTC(y, m - 1, d) / 1000;
  let utc = wallMidnight;
  for (let i = 0; i < 4; i += 1) {
    const candidate = wallMidnight - utcOffsetAt(utc);
    if (candidate === utc) return utc;
    utc = candidate;
  }
  return utc;
}

/** UTC epoch second of the Monday 00:00 local of the week containing utcSec. */
export function weekStartUtc(utcSec: number): number {
  const wallSec = utcSec + utcOffsetAt(utcSec);
  const wallDay = Math.floor(wallSec / SECONDS_PER_DAY);
  // 1970-01-01 (day 0) was a Thursday; Monday-based index:
  const mondayIndex = (wallDay % 7 + 7) % 7; // 0=Thu ... 3=Sun, 4=Mon ...
  const daysSinceMonday = (mondayIndex - 4 + 7) % 7;
  const mondayWallMidnight = (wallDay - daysSinceMonday) * SECONDS_PER_DAY;
  const mondayDate = new Date(mondayWallMidnight * 1000);
  const yyyy = mondayDate.getUTCFullYear();
  const mm = String(mondayDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(mondayDate.getUTCDate()).padStart(2, "0");
  return localMidnightToUtc(`${yyyy}-${mm}-${dd}`);
}
