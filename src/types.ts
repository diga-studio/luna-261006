/** 月份标识，格式 YYYY-MM（UTC）。 */
export type MonthId = string;

/** 一个兑换/取消中针对某个月份批次的份额。 */
export interface MonthShare {
  month: MonthId;
  cents: number;
}

/** credit 返回的记录。 */
export interface CreditRecord {
  employeeId: string;
  month: MonthId;
  cents: number;
  key: string;
  createdAtMs: number;
}

/** redeem 成功结果。 */
export interface RedeemResult {
  redemptionId: string;
  employeeId: string;
  cents: number;
  shares: MonthShare[];
  createdAtMs: number;
}

/** cancel 成功结果（首次取消与窗口内重放共用）。 */
export interface CancelResult {
  redemptionId: string;
  employeeId: string;
  cents: number;
  /** 按最初扣款份额全额冲正；reusable=false 的部分计入 expired。 */
  refunds: (MonthShare & { reusable: boolean })[];
  cancelledAtMs: number;
}

/** snapshot 中单个批次的情况。 */
export interface BatchSnapshot {
  month: MonthId;
  allocated: number;
  available: number;
  spent: number;
  expired: number;
  /** 到期时刻（epoch ms），不含该时刻。 */
  expiresAtMs: number;
}

/** snapshot 返回结果。 */
export interface Snapshot {
  employeeId: string;
  totalAvailable: number;
  batches: BatchSnapshot[];
}

export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

/** 额度不足，兑换整体失败。 */
export class InsufficientFundsError extends LedgerError {
  constructor(message: string) {
    super('INSUFFICIENT_FUNDS', message);
  }
}

/** 超过 24 小时取消期限。 */
export class CancelWindowExpiredError extends LedgerError {
  constructor(message: string) {
    super('CANCEL_WINDOW_EXPIRED', message);
  }
}

/** 兑换不存在或不属于该员工。 */
export class RedemptionNotFoundError extends LedgerError {
  constructor(message: string) {
    super('REDEMPTION_NOT_FOUND', message);
  }
}
