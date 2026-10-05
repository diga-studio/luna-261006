/** A prepaid subscription item. Amounts are integer cents. Dates are ISO YYYY-MM-DD (UTC). */
export interface PrepaidItem {
  id: string;
  amount: bigint;
  startDate: string;
  endDate: string;
}

/** A refund tied to a previously ingested item. */
export interface Refund {
  itemId: string;
  amount: bigint;
  date: string;
}

/** Closed result for a single day. */
export interface DailyResult {
  date: string;
  revenue: bigint;
  deferred: bigint;
}

/** Exported report for a closed date range (inclusive on both ends). */
export interface RangeReport {
  from: string;
  to: string;
  totalRevenue: bigint;
  days: DailyResult[];
}
