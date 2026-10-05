/** 记录结论：发生 / 未发生 */
export type Verdict = "occurred" | "notOccurred";

/** 时刻判定结果：确定发生 / 确定未发生 / 未知 */
export type PointState = "occurred" | "notOccurred" | "unknown";

/** 一条行为观察记录，时间范围左闭右开 [startMs, endMs) */
export interface BehaviorRecord {
  id: string;
  startMs: number;
  endMs: number;
  verdict: Verdict;
}

/** 三种观察方法 */
export type Method = "whole" | "partial" | "momentary";

/** 单个区间的判定结果 */
export type IntervalState = "occurred" | "notOccurred" | "unknown";

/** 一种方法的统计结果 */
export interface MethodStats {
  occurred: number;
  notOccurred: number;
  unknown: number;
  /** occurred / (occurred + notOccurred)；无可判定区间时为 null */
  occurredRatio: number | null;
}

/** 范围报告：三种方法各自的统计 */
export interface RangeReport {
  whole: MethodStats;
  partial: MethodStats;
  momentary: MethodStats;
}

/** 区间长度（毫秒） */
export const INTERVAL_MS = 10000;

/** 瞬时采样点在区间内的偏移（毫秒） */
export const SAMPLE_OFFSET_MS = 5000;
