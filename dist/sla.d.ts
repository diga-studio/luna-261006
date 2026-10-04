import { BusinessCalendar, LeadInspection } from "./types";
/** 线索 SLA 上限：4 个营业小时。 */
export declare const SLA_LIMIT_MS: number;
/** 从 from 开始、到 to 之前累计的营业毫秒数。 */
export declare function elapsed(calendar: BusinessCalendar, from: number, to: number): number;
/** 不早于 from、且累计营业耗时首次达到 budgetMs 的时刻。 */
export declare function advance(calendar: BusinessCalendar, from: number, budgetMs: number): number;
/** 线索检查：计时止于 asOf 与首次跟进时刻的较早者；耗时严格大于 4 小时才超时。 */
export declare function inspectLead(calendar: BusinessCalendar, createdAt: number, firstActionAt: number | null, asOf: number): LeadInspection;
