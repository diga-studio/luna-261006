/**
 * 时区工具：基于 Intl 计算 IANA 时区在某一 UTC 分钟处的偏移，
 * 并把一段 UTC 区间切分为偏移恒定的若干段（段边界即 DST 切换点）。
 *
 * 可用性判断一律走"UTC 时刻 -> 本地墙钟"的正向方向，避免本地时间
 * 不存在（春拨）或重复（秋拨）带来的歧义。
 */

/** 一段 UTC 区间 [startUtcMinutes, endUtcMinutes) 内偏移（分钟，local = utc + offset）恒定。 */
export interface OffsetSegment {
  startUtcMinutes: number;
  endUtcMinutes: number;
  offsetMinutes: number;
}

const MINUTE_MS = 60_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    // 非法时区名会在这里抛 RangeError，属于调用方输入错误。
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

/** 返回 timeZone 在 utcEpochMs 时刻的偏移分钟数（local = utc + offset）。 */
export function offsetMinutesAt(timeZone: string, utcEpochMs: number): number {
  const parts = getFormatter(timeZone).formatToParts(utcEpochMs);
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
  if (hour === 24) hour = 0; // 个别 ICU 版本午夜会给出 24
  const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((localAsUtcMs - utcEpochMs) / MINUTE_MS);
}

/** 在 (loMinutes, hiMinutes] 内找到第一个偏移不等于 oldOffset 的分钟。 */
function findTransitionMinute(
  timeZone: string,
  loMinutes: number,
  hiMinutes: number,
  oldOffset: number,
): number {
  let lo = loMinutes;
  let hi = hiMinutes;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (offsetMinutesAt(timeZone, mid * MINUTE_MS) === oldOffset) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

/** 采样步长（分钟）。2020..2035 年间同一时区相邻两次切换间隔远大于 6 小时。 */
const SAMPLE_STEP_MINUTES = 360;

/**
 * 把 [startUtcMinutes, endUtcMinutes) 切分为偏移恒定的连续段，
 * 按时间升序返回，覆盖整个区间且无重叠。
 */
export function offsetSegments(
  timeZone: string,
  startUtcMinutes: number,
  endUtcMinutes: number,
): OffsetSegment[] {
  if (endUtcMinutes <= startUtcMinutes) return [];
  const segments: OffsetSegment[] = [];
  let segStart = startUtcMinutes;
  let segOffset = offsetMinutesAt(timeZone, segStart * MINUTE_MS);
  let prevMinute = segStart;
  let prevOffset = segOffset;
  for (let m = segStart + SAMPLE_STEP_MINUTES; m < endUtcMinutes; m += SAMPLE_STEP_MINUTES) {
    const off = offsetMinutesAt(timeZone, m * MINUTE_MS);
    if (off !== prevOffset) {
      const t = findTransitionMinute(timeZone, prevMinute, m, prevOffset);
      segments.push({
        startUtcMinutes: segStart,
        endUtcMinutes: t,
        offsetMinutes: segOffset,
      });
      segStart = t;
      segOffset = off;
    }
    prevMinute = m;
    prevOffset = off;
  }
  segments.push({
    startUtcMinutes: segStart,
    endUtcMinutes: endUtcMinutes,
    offsetMinutes: segOffset,
  });
  return segments;
}
