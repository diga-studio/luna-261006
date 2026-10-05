export const INTERVAL_LENGTH_MS = 10_000;
export const SAMPLING_OFFSET_MS = 5_000;

export type RecordId = string;

export interface BehaviorRecord {
  readonly id: RecordId;
  readonly startMs: number;
  readonly endMs: number;
  readonly occurred: boolean;
}

export type PointConclusion = "occurred" | "notOccurred" | "unknown";

export type IntervalVerdict = "occurred" | "notOccurred" | "unknown";

export interface MethodStats {
  readonly occurred: number;
  readonly notOccurred: number;
  readonly unknown: number;
  readonly occurredRatio: number | null;
}

export interface ObservationReport {
  readonly wholeInterval: MethodStats;
  readonly partialInterval: MethodStats;
  readonly momentarySampling: MethodStats;
}
