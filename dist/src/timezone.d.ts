/** UTC 时刻在时区下的当地日期 YYYY-MM-DD。 */
export declare function localDateOf(timeZone: string, utcMs: number): string;
export declare function formatLocalDate(y: number, m: number, d: number): string;
/**
 * 将 IANA 时区下的当地日期+时刻换算为 UTC 时刻（epoch ms）。
 * - 时刻重复（时钟回拨）：取较早的 UTC 时刻。
 * - 时刻不存在（时钟前跳）：按实际偏移变化量向后平移；若平移后跨出原定日期
 *   （例如整日被跳过），返回 null。
 */
export declare function localToUtcMs(timeZone: string, date: string, time: string): number | null;
/** 判断某当地日期在该时区下是否存在（整日被跳过时为 false）。 */
export declare function localDateExists(timeZone: string, date: string): boolean;
