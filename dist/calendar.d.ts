import { BusinessCalendar, BusinessWindow } from "./types";
/** 某当地日期生效的营业窗口（例外表优先，整日替换；空列表表示休息）。 */
export declare function windowsForDate(calendar: BusinessCalendar, date: string): BusinessWindow[];
/** "HH:mm"（允许 "24:00"）转为当日毫秒数。 */
export declare function parseWallTime(hhmm: string): number;
