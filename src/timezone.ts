/** 企业固定时区。 */
export const TIME_ZONE = "America/New_York";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockAt(utcSeconds: number): WallClock {
  const parts = formatter.formatToParts(new Date(utcSeconds * 1000));
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

/** 给定 UTC 纪元秒，返回该时区当前的 UTC 偏移（秒，东部为负）。 */
export function utcOffsetSecondsAt(utcSeconds: number): number {
  const wall = wallClockAt(utcSeconds);
  const wallAsUtc =
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) / 1000;
  return wallAsUtc - utcSeconds;
}

/** 本地日期时间（YYYY-MM-DD + 当天秒数）对应的 UTC 纪元秒。 */
export function localToUtc(
  localDate: string,
  secondsOfDay: number,
): number {
  const [year, month, day] = localDate.split("-").map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0) / 1000 + secondsOfDay;
  // 迭代求不动点：utc = wallAsUtc - offset(utc)。本地午夜附近偏移恒定，两次收敛。
  let utc = wallAsUtc - utcOffsetSecondsAt(wallAsUtc);
  for (let i = 0; i < 3; i += 1) {
    const next = wallAsUtc - utcOffsetSecondsAt(utc);
    if (next === utc) {
      break;
    }
    utc = next;
  }
  return utc;
}

/** UTC 纪元秒对应的本地日期（YYYY-MM-DD）。 */
export function utcToLocalDate(utcSeconds: number): string {
  const wall = wallClockAt(utcSeconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** 包含 utcSeconds 的自然周起点（本地周一 00:00）的 UTC 纪元秒。 */
export function weekStartUtc(utcSeconds: number): number {
  const wall = wallClockAt(utcSeconds);
  const dayMs = 24 * 3600 * 1000;
  const dateUtcMs = Date.UTC(wall.year, wall.month - 1, wall.day);
  const dayOfWeek = new Date(dateUtcMs).getUTCDay(); // 0=周日
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const mondayMs = dateUtcMs - daysSinceMonday * dayMs;
  const monday = new Date(mondayMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const mondayDate = `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
  return localToUtc(mondayDate, 0);
}
