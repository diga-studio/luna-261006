"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inspectLead = exports.advance = exports.elapsed = exports.SLA_LIMIT_MS = void 0;
const calendar_1 = require("./calendar");
const timezone_1 = require("./timezone");
/** 线索 SLA 上限：4 个营业小时。 */
exports.SLA_LIMIT_MS = 4 * 60 * 60 * 1000;
/** 某当地日期所有营业窗口映射到真实时间后的并集（升序、不重叠的半开区间）。 */
function openIntervalsForDate(calendar, date) {
    const pieces = [];
    for (const w of (0, calendar_1.windowsForDate)(calendar, date)) {
        const startMsOfDay = (0, calendar_1.parseWallTime)(w.start);
        const endMsOfDay = (0, calendar_1.parseWallTime)(w.end);
        if (endMsOfDay <= startMsOfDay)
            continue;
        pieces.push(...(0, timezone_1.wallIntervalToUtc)(date, startMsOfDay, endMsOfDay, calendar.timeZone));
    }
    pieces.sort((a, b) => a.startMs - b.startMs);
    const merged = [];
    for (const p of pieces) {
        const last = merged[merged.length - 1];
        if (last && p.startMs <= last.endMs) {
            last.endMs = Math.max(last.endMs, p.endMs);
        }
        else {
            merged.push({ startMs: p.startMs, endMs: p.endMs });
        }
    }
    return merged;
}
/** 从 from 开始、到 to 之前累计的营业毫秒数。 */
function elapsed(calendar, from, to) {
    if (to <= from)
        return 0;
    const lastDate = (0, timezone_1.localPartsAt)(to, calendar.timeZone).date;
    let total = 0;
    for (let date = (0, timezone_1.localPartsAt)(from, calendar.timeZone).date;; date = (0, timezone_1.nextLocalDate)(date)) {
        for (const iv of openIntervalsForDate(calendar, date)) {
            const s = Math.max(iv.startMs, from);
            const e = Math.min(iv.endMs, to);
            if (e > s)
                total += e - s;
        }
        if (date >= lastDate)
            break;
    }
    return total;
}
exports.elapsed = elapsed;
/** 不早于 from、且累计营业耗时首次达到 budgetMs 的时刻。 */
function advance(calendar, from, budgetMs) {
    if (budgetMs <= 0)
        return from;
    let remaining = budgetMs;
    for (let date = (0, timezone_1.localPartsAt)(from, calendar.timeZone).date;; date = (0, timezone_1.nextLocalDate)(date)) {
        for (const iv of openIntervalsForDate(calendar, date)) {
            const s = Math.max(iv.startMs, from);
            const e = iv.endMs;
            if (e <= s)
                continue;
            const len = e - s;
            if (len >= remaining)
                return s + remaining;
            remaining -= len;
        }
    }
}
exports.advance = advance;
/** 线索检查：计时止于 asOf 与首次跟进时刻的较早者；耗时严格大于 4 小时才超时。 */
function inspectLead(calendar, createdAt, firstActionAt, asOf) {
    const end = firstActionAt === null ? asOf : Math.min(asOf, firstActionAt);
    const elapsedBusinessMs = elapsed(calendar, createdAt, end);
    return { elapsedBusinessMs, breached: elapsedBusinessMs > exports.SLA_LIMIT_MS };
}
exports.inspectLead = inspectLead;
