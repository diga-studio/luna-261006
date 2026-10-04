"use strict";
/** 时区换算辅助：基于 Intl，所有绝对时刻为整数毫秒。 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.wallIntervalToUtc = exports.nextLocalDate = exports.localPartsAt = void 0;
const DAY_MS = 86400000;
const formatCache = new Map();
function formatterFor(timeZone) {
    let fmt = formatCache.get(timeZone);
    if (!fmt) {
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
        formatCache.set(timeZone, fmt);
    }
    return fmt;
}
function pad2(n) {
    return n < 10 ? "0" + n : String(n);
}
/** 求某真实时刻在指定时区的当地日期与当日毫秒。 */
function localPartsAt(instantMs, timeZone) {
    const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
    let year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
    for (const p of parts) {
        switch (p.type) {
            case "year":
                year = Number(p.value);
                break;
            case "month":
                month = Number(p.value);
                break;
            case "day":
                day = Number(p.value);
                break;
            case "hour":
                hour = Number(p.value) % 24;
                break;
            case "minute":
                minute = Number(p.value);
                break;
            case "second":
                second = Number(p.value);
                break;
        }
    }
    const secMs = Math.floor(instantMs / 1000) * 1000;
    const fracMs = instantMs - secMs;
    return {
        date: `${year}-${pad2(month)}-${pad2(day)}`,
        msOfDay: ((hour * 60 + minute) * 60 + second) * 1000 + fracMs,
    };
}
exports.localPartsAt = localPartsAt;
/** 某真实时刻的时区偏移（当地时间减 UTC，毫秒）。 */
function offsetMsAt(instantMs, timeZone) {
    const p = localPartsAt(instantMs, timeZone);
    const wallAsUtc = Date.parse(p.date + "T00:00:00Z") + p.msOfDay;
    return wallAsUtc - instantMs;
}
/** 当地日期的下一日 "YYYY-MM-DD"。 */
function nextLocalDate(date) {
    return new Date(Date.parse(date + "T00:00:00Z") + DAY_MS).toISOString().slice(0, 10);
}
exports.nextLocalDate = nextLocalDate;
/** 把当地日期的午夜（00:00）解析为真实时刻。 */
function midnightUtc(date, timeZone) {
    const target = Date.parse(date + "T00:00:00Z");
    let guess = target;
    for (let i = 0; i < 10; i++) {
        const p = localPartsAt(guess, timeZone);
        const wall = Date.parse(p.date + "T00:00:00Z") + p.msOfDay;
        const diff = target - wall;
        if (diff === 0)
            return guess;
        guess += diff;
    }
    // 当地午夜不存在等极端情况：找第一个当地日期 >= date 的真实时刻。
    let lo = target - 2 * DAY_MS;
    let hi = target + 2 * DAY_MS;
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (localPartsAt(mid, timeZone).date >= date)
            hi = mid;
        else
            lo = mid;
    }
    return hi;
}
/** 在 [lo, hi] 内找偏移从 offsetMsAt(lo) 变为其他值的全部跳变点（毫秒精度）。 */
function findOffsetTransitions(lo, hi, timeZone) {
    const transitions = [];
    const STEP = 15 * 60000;
    let prev = lo;
    let t = lo + STEP;
    while (prev < hi) {
        const cur = Math.min(t, hi);
        const prevOffset = offsetMsAt(prev, timeZone);
        if (offsetMsAt(cur, timeZone) !== prevOffset) {
            // 二分找第一个偏移不等于 prev 处偏移的真实时刻
            let a = prev;
            let b = cur;
            while (b - a > 1) {
                const mid = Math.floor((a + b) / 2);
                if (offsetMsAt(mid, timeZone) === prevOffset)
                    a = mid;
                else
                    b = mid;
            }
            transitions.push(b);
        }
        prev = cur;
        t += STEP;
    }
    return transitions;
}
/**
 * 把当地日期 + 当日毫秒区间 [startMsOfDay, endMsOfDay) 映射为真实时刻区间列表。
 * 回拨时一段钟面窗口可对应两段互不相连的真实时间；被跳过的钟面时间不出现。
 * 返回半开区间列表，按时间升序。
 */
function wallIntervalToUtc(date, startMsOfDay, endMsOfDay, timeZone) {
    const wallBase = Date.parse(date + "T00:00:00Z");
    const dayStart = midnightUtc(date, timeZone);
    const dayEnd = midnightUtc(nextLocalDate(date), timeZone);
    const bounds = [dayStart, ...findOffsetTransitions(dayStart, dayEnd, timeZone), dayEnd];
    const result = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
        const segStart = bounds[i];
        const segEnd = bounds[i + 1];
        if (segEnd <= segStart)
            continue;
        const offset = offsetMsAt(segStart, timeZone);
        // 该段内 墙钟毫秒 = 真实时刻 + offset - wallBase
        const wallLo = segStart + offset - wallBase;
        const wallHi = segEnd + offset - wallBase;
        const lo = Math.max(wallLo, startMsOfDay);
        const hi = Math.min(wallHi, endMsOfDay);
        if (hi > lo) {
            result.push({ startMs: lo - offset + wallBase, endMs: hi - offset + wallBase });
        }
    }
    return result;
}
exports.wallIntervalToUtc = wallIntervalToUtc;
