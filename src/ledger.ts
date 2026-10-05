import { randomUUID } from 'node:crypto';
import type { Clock } from './clock.ts';
import { expiryMs, monthOf } from './months.ts';
import { Store } from './store.ts';
import {
  CancelWindowExpiredError,
  InsufficientFundsError,
  LedgerError,
  RedemptionNotFoundError,
  type CancelResult,
  type CreditRecord,
  type MonthShare,
  type RedeemResult,
  type Snapshot,
} from './types.ts';

export interface LedgerOptions {
  clock: Clock;
}

/** 首次取消期限：兑换成功后 24 小时内（恰好满 24 小时不允许）。 */
export const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 去重结果保留窗口：48 小时（恰好满 48 小时按新请求处理）。 */
export const DEDUP_WINDOW_MS = 48 * 60 * 60 * 1000;

type Op = 'credit' | 'redeem' | 'cancel';

/**
 * 员工补贴账本。
 *
 * 批次的 available / expired 不落库，由 allocated、spent 与时钟推导：
 * - 未到期：available = allocated - spent，expired = 0
 * - 已到期：available = 0，expired = allocated - spent
 * 因此 allocated = available + spent + expired 恒成立，且到期无需清理操作。
 */
export class Ledger {
  private store: Store;
  private clock: Clock;

  constructor(dbPath: string, options: LedgerOptions) {
    this.store = new Store(dbPath);
    this.clock = options.clock;
  }

  close(): void {
    this.store.close();
  }

  credit(employeeId: string, cents: number, key: string): CreditRecord {
    validate(employeeId, cents, key);
    const now = this.clock.nowMs();
    const month = monthOf(now);
    const hash = requestHash(cents);

    const replayed = this.replay<CreditRecord>(employeeId, key, 'credit', hash, now);
    if (replayed) return replayed;

    return this.store.transaction(() => {
      const existing = this.store.getBatch(employeeId, month);
      if (existing) {
        // 同一员工同一月份只能发放一笔：返回原记录（与 key 无关）。
        return {
          employeeId,
          month,
          cents: existing.allocated,
          key: existing.key,
          createdAtMs: existing.createdAtMs,
        };
      }
      const record: CreditRecord = { employeeId, month, cents, key, createdAtMs: now };
      this.store.insertBatch({
        employeeId,
        month,
        allocated: cents,
        spent: 0,
        key,
        createdAtMs: now,
      });
      this.remember(employeeId, key, 'credit', hash, record, now);
      return record;
    });
  }

  redeem(employeeId: string, cents: number, key: string): RedeemResult {
    validate(employeeId, cents, key);
    const now = this.clock.nowMs();
    const hash = requestHash(cents);

    const replayed = this.replay<RedeemResult>(employeeId, key, 'redeem', hash, now);
    if (replayed) return replayed;

    return this.store.transaction(() => {
      // 按到期先后（月份升序）消耗；已到期批次可用为 0。
      const batches = this.store.listBatches(employeeId).map((b) => ({
        month: b.month,
        available: now < expiryMs(b.month) ? b.allocated - b.spent : 0,
      }));
      const total = batches.reduce((sum, b) => sum + b.available, 0);
      if (total < cents) {
        throw new InsufficientFundsError(
          `employee ${employeeId}: need ${cents} cents, only ${total} available`,
        );
      }

      const shares: MonthShare[] = [];
      let remaining = cents;
      for (const b of batches) {
        if (remaining === 0) break;
        if (b.available <= 0) continue;
        const take = Math.min(b.available, remaining);
        shares.push({ month: b.month, cents: take });
        this.store.addSpent(employeeId, b.month, take);
        remaining -= take;
      }

      const result: RedeemResult = {
        redemptionId: randomUUID(),
        employeeId,
        cents,
        shares,
        createdAtMs: now,
      };
      this.store.insertRedemption({
        id: result.redemptionId,
        employeeId,
        cents,
        createdAtMs: now,
        cancelledAtMs: null,
      });
      for (const s of shares) {
        this.store.insertShare({ redemptionId: result.redemptionId, month: s.month, cents: s.cents });
      }
      this.remember(employeeId, key, 'redeem', hash, result, now);
      return result;
    });
  }

  cancel(employeeId: string, redemptionId: string, key: string): CancelResult {
    if (!employeeId) throw new LedgerError('INVALID_ARGUMENT', 'employeeId is required');
    if (!redemptionId) throw new LedgerError('INVALID_ARGUMENT', 'redemptionId is required');
    if (!key) throw new LedgerError('INVALID_ARGUMENT', 'key is required');
    const now = this.clock.nowMs();
    const hash = requestHash(redemptionId);

    // 去重重放优先于 24 小时期限判断：窗口内重放成功取消不重新判失败。
    const replayed = this.replay<CancelResult>(employeeId, key, 'cancel', hash, now);
    if (replayed) return replayed;

    return this.store.transaction(() => {
      const redemption = this.store.getRedemption(redemptionId);
      if (!redemption || redemption.employeeId !== employeeId) {
        throw new RedemptionNotFoundError(
          `redemption ${redemptionId} not found for employee ${employeeId}`,
        );
      }
      const shares = this.store.listShares(redemptionId);

      if (redemption.cancelledAtMs !== null) {
        // 已取消：返回原取消结果，不再返钱，不受 24 小时限制。
        return buildCancelResult(redemption.id, employeeId, redemption.cents, shares, redemption.cancelledAtMs);
      }
      if (now - redemption.createdAtMs >= CANCEL_WINDOW_MS) {
        throw new CancelWindowExpiredError(
          `redemption ${redemptionId} created at ${redemption.createdAtMs}, cannot cancel at ${now}`,
        );
      }

      // 按最初扣款份额全额冲正：spent 减少；未到期部分重新可用，
      // 已到期部分因推导规则自动计入 expired，不重置有效期。
      for (const s of shares) {
        this.store.addSpent(employeeId, s.month, -s.cents);
      }
      this.store.markCancelled(redemptionId, now);

      const result = buildCancelResult(redemptionId, employeeId, redemption.cents, shares, now);
      this.remember(employeeId, key, 'cancel', hash, result, now);
      return result;
    });
  }

  snapshot(employeeId: string): Snapshot {
    if (!employeeId) throw new LedgerError('INVALID_ARGUMENT', 'employeeId is required');
    const now = this.clock.nowMs();
    const batches = this.store.listBatches(employeeId).map((b) => {
      const expiresAtMs = expiryMs(b.month);
      const live = now < expiresAtMs;
      const available = live ? b.allocated - b.spent : 0;
      const expired = live ? 0 : b.allocated - b.spent;
      return {
        month: b.month,
        allocated: b.allocated,
        available,
        spent: b.spent,
        expired,
        expiresAtMs,
      };
    });
    return {
      employeeId,
      totalAvailable: batches.reduce((sum, b) => sum + b.available, 0),
      batches,
    };
  }

  /** 窗口内相同操作及参数返回首次结果；恰好满 48 小时按新请求处理。 */
  private replay<T>(employeeId: string, key: string, op: Op, hash: string, now: number): T | null {
    const row = this.store.getIdempotency(employeeId, key, op, hash);
    if (!row) return null;
    if (now - row.createdAtMs >= DEDUP_WINDOW_MS) return null;
    return JSON.parse(row.resultJson) as T;
  }

  /** 记录首次成功结果；重试不写库，窗口不延长。 */
  private remember(employeeId: string, key: string, op: Op, hash: string, result: unknown, now: number): void {
    this.store.putIdempotency({
      employeeId,
      key,
      op,
      requestHash: hash,
      resultJson: JSON.stringify(result),
      createdAtMs: now,
    });
  }
}

function buildCancelResult(
  redemptionId: string,
  employeeId: string,
  cents: number,
  shares: MonthShare[],
  cancelledAtMs: number,
): CancelResult {
  return {
    redemptionId,
    employeeId,
    cents,
    refunds: shares.map((s) => ({
      month: s.month,
      cents: s.cents,
      reusable: cancelledAtMs < expiryMs(s.month),
    })),
    cancelledAtMs,
  };
}

/** 参数指纹：只含操作参数，不含调用时间。 */
function requestHash(...args: (string | number)[]): string {
  return JSON.stringify(args);
}

function validate(employeeId: string, cents: number, key: string): void {
  if (!employeeId) throw new LedgerError('INVALID_ARGUMENT', 'employeeId is required');
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new LedgerError('INVALID_ARGUMENT', 'cents must be a positive integer');
  }
  if (!key) throw new LedgerError('INVALID_ARGUMENT', 'key is required');
}
