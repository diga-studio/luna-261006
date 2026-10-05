import type { OffsetSegment } from "./tz.js";
import type { WeeklyWindow } from "./types.js";

/** 一周分钟数。 */
const WEEK_MINUTES = 7 * 24 * 60;
const DAY_MINUTES = 24 * 60;

/** 半开区间 [startUtcMinutes, endUtcMinutes)。 */
export interface UtcInterval {
  startUtcMinutes: number;
  endUtcMinutes: number;
}

/**
 * 把周窗口换算到"本地纪元分钟"空间中的起始位置。
 * 本地纪元分钟 0 = 1970-01-01 00:00 本地墙钟，该日为周四（getDay() === 4）。
 */
function windowStartInLocalWeek(window: WeeklyWindow): number {
  return (((window.dayOfWeek + 3) % 7) + 7) % 7 * DAY_MINUTES + window.startMinuteOfDay;
}

/** 窗口时长（分钟）。结束早于等于开始表示跨到次日；起止相同不合法，由调用方校验。 */
function windowDuration(window: WeeklyWindow): number {
  const d = window.endMinuteOfDay - window.startMinuteOfDay;
  return d > 0 ? d : d + DAY_MINUTES;
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function ceilDiv(a: number, b: number): number {
  return -Math.floor(-a / b);
}

/**
 * 计算一名董事在 [rangeStart, rangeEnd)（UTC 纪元分钟）内的可用区间。
 *
 * 思路：在偏移恒定的每个段内，本地时间 = UTC + offset 是线性映射；
 * 周窗口在"本地纪元分钟"空间中以 10080 分钟为周期重复，
 * 逐次出现换算回 UTC 并裁剪到段内，最后合并相邻/重叠区间。
 */
export function computeAvailableIntervals(
  windows: WeeklyWindow[],
  segments: OffsetSegment[],
  rangeStart: number,
  rangeEnd: number,
): UtcInterval[] {
  if (windows.length === 0 || rangeEnd <= rangeStart) return [];
  const raw: UtcInterval[] = [];
  for (const seg of segments) {
    const localStart = seg.startUtcMinutes + seg.offsetMinutes;
    const localEnd = seg.endUtcMinutes + seg.offsetMinutes;
    for (const window of windows) {
      const p0 = windowStartInLocalWeek(window);
      const duration = windowDuration(window);
      // 出现的本地区间为 [p0 + 10080k, p0 + duration + 10080k)，求与 [localStart, localEnd) 相交的 k。
      const kMin = floorDiv(localStart - p0 - duration, WEEK_MINUTES) + 1;
      const kMax = ceilDiv(localEnd - p0, WEEK_MINUTES) - 1;
      for (let k = kMin; k <= kMax; k++) {
        const start = p0 + WEEK_MINUTES * k - seg.offsetMinutes;
        const end = start + duration;
        const clippedStart = Math.max(start, seg.startUtcMinutes, rangeStart);
        const clippedEnd = Math.min(end, seg.endUtcMinutes, rangeEnd);
        if (clippedStart < clippedEnd) {
          raw.push({ startUtcMinutes: clippedStart, endUtcMinutes: clippedEnd });
        }
      }
    }
  }
  if (raw.length === 0) return [];
  raw.sort((a, b) => a.startUtcMinutes - b.startUtcMinutes);
  const merged: UtcInterval[] = [];
  let cur = raw[0];
  for (let i = 1; i < raw.length; i++) {
    const next = raw[i];
    if (next.startUtcMinutes <= cur.endUtcMinutes) {
      if (next.endUtcMinutes > cur.endUtcMinutes) cur.endUtcMinutes = next.endUtcMinutes;
    } else {
      merged.push(cur);
      cur = next;
    }
  }
  merged.push(cur);
  return merged;
}
