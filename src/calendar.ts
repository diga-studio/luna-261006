import { BusinessCalendar, BusinessWindow } from "./types";

/** 某当地日期生效的营业窗口（例外表优先，整日替换；空列表表示休息）。 */
export function windowsForDate(calendar: BusinessCalendar, date: string): BusinessWindow[] {
  const override = calendar.exceptions[date];
  if (override !== undefined) return override;
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  return calendar.weekly[day] ?? [];
}

/** "HH:mm"（允许 "24:00"）转为当日毫秒数。 */
export function parseWallTime(hhmm: string): number {
  const [hh, mm] = hhmm.split(":").map(Number);
  return (hh * 60 + mm) * 60_000;
}
