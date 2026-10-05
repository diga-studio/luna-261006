/**
 * 每周重复的空闲窗口，按董事所在时区的本地日历解释。
 * 所有时间均为"本地分钟"：minuteOfDay 取值 0..1439。
 */
export interface WeeklyWindow {
  /** 本周内的开始星期，0 = 周日 … 6 = 周六（与 Date#getDay 一致）。 */
  dayOfWeek: number;
  /** 本地开始时分（当日分钟数，0..1439），闭区间起点。 */
  startMinuteOfDay: number;
  /**
   * 本地结束时分（当日分钟数，0..1439），开区间终点。
   * 若小于等于 startMinuteOfDay 表示跨到次日；起止不得相同。
   */
  endMinuteOfDay: number;
}

/** 在任董事。id 稳定唯一；timeZone 为 IANA 时区名。身份信息由调用方提供。 */
export interface Director {
  id: string;
  timeZone: string;
}

/** 查询候选时段的入参。时间统一使用 UTC 纪元分钟（number，整分钟）。 */
export interface FindCandidatesQuery {
  /** 受邀董事 id 子集，必须都属于在任名册。 */
  invitedIds: string[];
  /** 法定比例（整数百分比 1..100），默认 60。 */
  quorumPercent?: number;
  /** 搜索范围起点（UTC 纪元分钟，含）。 */
  rangeStartUtcMinutes: number;
  /** 搜索范围终点（UTC 纪元分钟，不含）。 */
  rangeEndUtcMinutes: number;
  /** 会议时长（正整数分钟，真实经过时间）。 */
  durationMinutes: number;
}

/**
 * 一段最大连续的合格开始分钟区间，首尾均为合格开始分钟（闭区间）。
 * 单位为 UTC 纪元分钟。
 */
export interface CandidateSegment {
  startUtcMinutes: number;
  endUtcMinutes: number;
}
