/** 时区换算辅助：基于 Intl，所有绝对时刻为整数毫秒。 */
export interface LocalParts {
    /** 当地日期 "YYYY-MM-DD" */
    date: string;
    /** 当地当日已过的毫秒数 [0, 86400000) */
    msOfDay: number;
}
/** 求某真实时刻在指定时区的当地日期与当日毫秒。 */
export declare function localPartsAt(instantMs: number, timeZone: string): LocalParts;
/** 当地日期的下一日 "YYYY-MM-DD"。 */
export declare function nextLocalDate(date: string): string;
/**
 * 把当地日期 + 当日毫秒区间 [startMsOfDay, endMsOfDay) 映射为真实时刻区间列表。
 * 回拨时一段钟面窗口可对应两段互不相连的真实时间；被跳过的钟面时间不出现。
 * 返回半开区间列表，按时间升序。
 */
export declare function wallIntervalToUtc(date: string, startMsOfDay: number, endMsOfDay: number, timeZone: string): Array<{
    startMs: number;
    endMs: number;
}>;
