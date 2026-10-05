/** Injectable clock: returns current time in milliseconds since Unix epoch (UTC). */
export type Clock = () => number;

/** A monthly credit batch as seen in a snapshot. */
export interface BatchSnapshot {
  /** UTC month of issuance, "YYYY-MM". */
  month: string;
  allocated: number;
  available: number;
  spent: number;
  expired: number;
}

/** Per-month share of a redemption or cancellation. */
export interface MonthShare {
  month: string;
  cents: number;
}

export interface CreditResult {
  employeeId: string;
  month: string;
  cents: number;
  /** True when this call created the batch; false when it replayed an earlier record. */
  created: boolean;
}

export interface RedeemResult {
  employeeId: string;
  redemptionId: string;
  cents: number;
  /** Portions deducted from each monthly batch, earliest-expiring first. */
  shares: MonthShare[];
}

export interface CancelResult {
  employeeId: string;
  redemptionId: string;
  cents: number;
  /** Portions reversed back onto each monthly batch. */
  shares: MonthShare[];
  /** Epoch ms when the cancellation was first applied. */
  cancelledAt: number;
}

export interface Snapshot {
  employeeId: string;
  /** Sum of available across all batches. */
  totalAvailable: number;
  batches: BatchSnapshot[];
}

export type LedgerErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'CANCEL_WINDOW_EXPIRED'
  | 'REDEMPTION_NOT_FOUND'
  | 'KEY_CONFLICT'
  | 'INVALID_ARGUMENT';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}
