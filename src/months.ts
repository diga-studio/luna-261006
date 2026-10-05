import type { MonthId } from './types.ts';

/** 额度有效期：发放月之后第 4 个月月初（不含）。 */
export const EXPIRY_MONTHS = 4;

/** 取某时刻所在的 UTC 月份，格式 YYYY-MM。 */
export function monthOf(ms: number): MonthId {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** 月份标识 -> 该月月初的 epoch ms。 */
export function monthStartMs(month: MonthId): number {
  const [y, m] = month.split('-').map(Number);
  return Date.UTC(y, m - 1, 1);
}

/** 批次到期时刻：发放月之后第 4 个月月初（不含该时刻）。 */
export function expiryMs(month: MonthId): number {
  const [y, m] = month.split('-').map(Number);
  return Date.UTC(y, m - 1 + EXPIRY_MONTHS, 1);
}
