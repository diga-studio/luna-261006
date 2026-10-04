import { windowsForDate, parseWallTime } from "./calendar";
import { localPartsAt, nextLocalDate, wallIntervalToUtc } from "./timezone";
import { BusinessCalendar, LeadInspection } from "./types";

/** 线索 SLA 上限：4 个营业小时。 */
export const SLA_LIMIT_MS = 4 * 60 * 60 * 1000;

interface UtcInterval {
  startMs: number;
  endMs: number;
}

/** 某当地日期所有营业窗口映射到真实时间后的并集（升序、不重叠的半开区间）。 */
function openIntervalsForDate(calendar: BusinessCalendar, date: string): UtcInterval[] {
  const pieces: UtcInterval[] = [];
  for (const w of windowsForDate(calendar, date)) {
    const startMsOfDay = parseWallTime(w.start);
    const endMsOfDay = parseWallTime(w.end);
    if (endMsOfDay <= startMsOfDay) continue;
    pieces.push(...wallIntervalToUtc(date, startMsOfDay, endMsOfDay, calendar.timeZone));
  }
  pieces.sort((a, b) => a.startMs - b.startMs);
  const merged: UtcInterval[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && p.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, p.endMs);
    } else {
      merged.push({ startMs: p.startMs, endMs: p.endMs });
    }
  }
  return merged;
}

/** 从 from 开始、到 to 之前累计的营业毫秒数。 */
export function elapsed(calendar: BusinessCalendar, from: number, to: number): number {
  if (to <= from) return 0;
  const lastDate = localPartsAt(to, calendar.timeZone).date;
  let total = 0;
  for (
    let date = localPartsAt(from, calendar.timeZone).date;
    ;
    date = nextLocalDate(date)
  ) {
    for (const iv of openIntervalsForDate(calendar, date)) {
      const s = Math.max(iv.startMs, from);
      const e = Math.min(iv.endMs, to);
      if (e > s) total += e - s;
    }
    if (date >= lastDate) break;
  }
  return total;
}

/** 不早于 from、且累计营业耗时首次达到 budgetMs 的时刻。 */
export function advance(calendar: BusinessCalendar, from: number, budgetMs: number): number {
  if (budgetMs <= 0) return from;
  let remaining = budgetMs;
  for (
    let date = localPartsAt(from, calendar.timeZone).date;
    ;
    date = nextLocalDate(date)
  ) {
    for (const iv of openIntervalsForDate(calendar, date)) {
      const s = Math.max(iv.startMs, from);
      const e = iv.endMs;
      if (e <= s) continue;
      const len = e - s;
      if (len >= remaining) return s + remaining;
      remaining -= len;
    }
  }
}

/** 线索检查：计时止于 asOf 与首次跟进时刻的较早者；耗时严格大于 4 小时才超时。 */
export function inspectLead(
  calendar: BusinessCalendar,
  createdAt: number,
  firstActionAt: number | null,
  asOf: number,
): LeadInspection {
  const end = firstActionAt === null ? asOf : Math.min(asOf, firstActionAt);
  const elapsedBusinessMs = elapsed(calendar, createdAt, end);
  return { elapsedBusinessMs, breached: elapsedBusinessMs > SLA_LIMIT_MS };
}
