/** 一日内的营业窗口，当地 "HH:mm"，开始包含、结束不包含，结束允许 "24:00"。 */
export interface BusinessWindow {
  start: string;
  end: string;
}

/** 营业日历：IANA 时区 + 每周各日窗口 + 当地日期键的例外覆盖表（空列表表示休息）。 */
export interface BusinessCalendar {
  timeZone: string;
  /** 0=周日 … 6=周六 */
  weekly: BusinessWindow[][];
  /** 键为当地日期 "YYYY-MM-DD"，整日替换周表。 */
  exceptions: Record<string, BusinessWindow[]>;
}

/** 线索 SLA 检查结果。 */
export interface LeadInspection {
  /** 从创建到计时终点累计的营业毫秒数。 */
  elapsedBusinessMs: number;
  /** 截至 asOf 是否曾超时（营业耗时严格大于 4 小时）。 */
  breached: boolean;
}
