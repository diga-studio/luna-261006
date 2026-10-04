/**
 * 一个本地时间区间，单位为自本地午夜起的分钟数，左闭右开。
 * endMinutes 早于 startMinutes 表示次日结束；二者相同表示延续 24 小时。
 */
export interface TimeInterval {
  startMinutes: number;
  endMinutes: number;
}

/**
 * 工作日历：一个 IANA 时区 + 每周各日工作区间 + 指定本地日期的例外区间。
 * 例外完全替换该日期的每周安排；空数组表示假日。
 * 键为本地日期 "YYYY-MM-DD"。
 */
export interface WorkCalendar {
  timeZone: string;
  /** 索引 0=周日 … 6=周六，每周总计不超过 14 段 */
  weekly: ReadonlyArray<readonly TimeInterval[]>;
  exceptions: Readonly<Record<string, readonly TimeInterval[]>>;
}

/** 里程碑定位结果；不可达时为 null。值为 UTC 毫秒时间戳。 */
export interface Milestones {
  remind50: number | null;
  remind80: number | null;
  deadline: number | null;
}
