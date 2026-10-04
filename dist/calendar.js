"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseWallTime = exports.windowsForDate = void 0;
/** 某当地日期生效的营业窗口（例外表优先，整日替换；空列表表示休息）。 */
function windowsForDate(calendar, date) {
    const override = calendar.exceptions[date];
    if (override !== undefined)
        return override;
    const day = new Date(date + "T00:00:00Z").getUTCDay();
    return calendar.weekly[day] ?? [];
}
exports.windowsForDate = windowsForDate;
/** "HH:mm"（允许 "24:00"）转为当日毫秒数。 */
function parseWallTime(hhmm) {
    const [hh, mm] = hhmm.split(":").map(Number);
    return (hh * 60 + mm) * 60000;
}
exports.parseWallTime = parseWallTime;
