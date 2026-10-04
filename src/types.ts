/**
 * 时间以“自本地午夜起的分钟数”表示，区间左闭右开。
 * endMinute <= startMinute 表示跨午夜（等于时表示延续到次日同一时刻，即 24 小时）。
 */
export interface WorkInterval {
  startMinute: number; // 0..1439
  endMinute: number;   // 0..1439
}

/** 每周各日的工作区间。索引 0 = 周日 … 6 = 周六（本地日期）。 */
export type WeeklySchedule = [
  WorkInterval[], WorkInterval[], WorkInterval[],
  WorkInterval[], WorkInterval[], WorkInterval[], WorkInterval[],
];

/** 指定本地日期的例外安排，完全替换该日的每周安排；空数组表示假日。 */
export interface ExceptionDay {
  /** 本地日期，格式 YYYY-MM-DD */
  date: string;
  intervals: WorkInterval[];
}

export interface WorkCalendar {
  /** IANA 时区名，如 "America/New_York" */
  timeZone: string;
  weekly: WeeklySchedule;
  exceptions?: ExceptionDay[];
}

export interface MilestoneResult {
  /** 达到该里程碑所需的累计工作毫秒数（向上取整后的额度） */
  quotaMs: number;
  /** 首次达到额度的 UTC 时刻（epoch ms）；不可达时为 null */
  at: number | null;
}

export interface SlaMilestones {
  remind50: MilestoneResult;
  remind80: MilestoneResult;
  deadline: MilestoneResult;
}
