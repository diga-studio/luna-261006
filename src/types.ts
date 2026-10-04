/** Month key in "YYYY-MM" form. */
export type MonthKey = string;

export type BatchStatus = "processing" | "completed";

export interface BatchInfo {
  batchId: string;
  month: MonthKey;
  status: BatchStatus;
  totalCount: number;
  doneCount: number;
}

export interface MemberResult {
  memberId: string;
  /** Commission in US cents (exact integer accounting). */
  commissionCents: number;
  /** True when commission exceeds $2500 (strictly greater than 250000 cents). */
  needsReview: boolean;
}

export const MAX_ADVANCE_PER_CALL = 200;
export const MAX_DEPTH = 12;
export const REVIEW_THRESHOLD_CENTS = 2500 * 100;

/** Cents of commission earned per 1 PV of a downline at depth d (1-based). */
export const CENTS_PER_PV_BY_DEPTH: readonly number[] = [
  0, // depth 0 unused
  5, // level 1: 5%
  3, // level 2: 3%
  2, 2, 2, // levels 3-5: 2%
  1, 1, 1, 1, 1, 1, 1, // levels 6-12: 1%
];
