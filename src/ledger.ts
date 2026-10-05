import { DatabaseSync } from 'node:sqlite';
import { LedgerError } from './types.js';
import type {
  CancelResult,
  Clock,
  CreditResult,
  MonthShare,
  RedeemResult,
  Snapshot,
} from './types.js';

export interface LedgerOptions {
  clock?: Clock;
}

const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEDUP_WINDOW_MS = 48 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  employee_id TEXT NOT NULL,
  month TEXT NOT NULL,
  allocated INTEGER NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0,
  expired INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (employee_id, month)
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL,
  cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER
);
CREATE TABLE IF NOT EXISTS redemption_shares (
  redemption_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  cents INTEGER NOT NULL,
  PRIMARY KEY (redemption_id, month)
);
CREATE TABLE IF NOT EXISTS dedup_keys (
  employee_id TEXT NOT NULL,
  key TEXT NOT NULL,
  op TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (employee_id, key)
);
`;

interface BatchRow {
  month: string;
  allocated: number;
  spent: number;
  expired: number;
}

function monthOf(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Expiry instant (epoch ms) of a batch issued in `month`: 1st of month+4, 00:00Z. */
function expiryOf(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return Date.UTC(y, m - 1 + 4, 1);
}

function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new LedgerError('INVALID_ARGUMENT', 'cents must be a positive safe integer');
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('INVALID_ARGUMENT', `${name} must be a non-empty string`);
  }
}

export class Ledger {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(dbPath: string, options: LedgerOptions = {}) {
    this.db = new DatabaseSync(dbPath);
    this.clock = options.clock ?? Date.now;
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  credit(employeeId: string, cents: number, key: string): CreditResult {
    assertNonEmpty(employeeId, 'employeeId');
    assertCents(cents);
    assertNonEmpty(key, 'key');
    const now = this.clock();
    const month = monthOf(now);
    const request = JSON.stringify({ cents });
    return this.runWrite<CreditResult>(employeeId, key, 'credit', request, now, () => {
      const existing = this.getBatch(employeeId, month);
      if (existing) {
        return { employeeId, month, cents: existing.allocated, created: false };
      }
      this.db
        .prepare(
          'INSERT INTO batches (employee_id, month, allocated, spent, expired, created_at) VALUES (?, ?, ?, 0, 0, ?)',
        )
        .run(employeeId, month, cents, now);
      return { employeeId, month, cents, created: true };
    });
  }

  redeem(employeeId: string, cents: number, key: string): RedeemResult {
    assertNonEmpty(employeeId, 'employeeId');
    assertCents(cents);
    assertNonEmpty(key, 'key');
    const now = this.clock();
    const request = JSON.stringify({ cents });
    return this.runWrite<RedeemResult>(employeeId, key, 'redeem', request, now, () => {
      const batches = this.liveBatches(employeeId, now);
      const totalAvailable = batches.reduce(
        (sum, b) => sum + (b.allocated - b.spent - b.expired),
        0,
      );
      if (totalAvailable < cents) {
        throw new LedgerError(
          'INSUFFICIENT_FUNDS',
          `available ${totalAvailable} < requested ${cents}`,
        );
      }
      let remaining = cents;
      const shares: MonthShare[] = [];
      for (const batch of batches) {
        if (remaining === 0) break;
        const available = batch.allocated - batch.spent - batch.expired;
        const take = Math.min(available, remaining);
        if (take <= 0) continue;
        this.db
          .prepare('UPDATE batches SET spent = spent + ? WHERE employee_id = ? AND month = ?')
          .run(take, employeeId, batch.month);
        shares.push({ month: batch.month, cents: take });
        remaining -= take;
      }
      const id = this.insertRedemption(employeeId, cents, shares, now);
      return { employeeId, redemptionId: id, cents, shares };
    });
  }

  cancel(employeeId: string, redemptionId: string, key: string): CancelResult {
    assertNonEmpty(employeeId, 'employeeId');
    assertNonEmpty(redemptionId, 'redemptionId');
    assertNonEmpty(key, 'key');
    const now = this.clock();
    const request = JSON.stringify({ redemptionId });
    return this.runWrite<CancelResult>(employeeId, key, 'cancel', request, now, () => {
      const redemption = this.getRedemption(employeeId, redemptionId);
      if (!redemption) {
        throw new LedgerError(
          'REDEMPTION_NOT_FOUND',
          `redemption ${redemptionId} not found for employee`,
        );
      }
      const shares = this.getShares(redemption.id);
      if (redemption.cancelled_at !== null) {
        return {
          employeeId,
          redemptionId,
          cents: redemption.cents,
          shares,
          cancelledAt: redemption.cancelled_at,
        };
      }
      if (now >= redemption.created_at + CANCEL_WINDOW_MS) {
        throw new LedgerError(
          'CANCEL_WINDOW_EXPIRED',
          'cancellation is only allowed within 24h of redemption',
        );
      }
      for (const share of shares) {
        const expired = expiryOf(share.month) <= now;
        this.db
          .prepare('UPDATE batches SET spent = spent - ? WHERE employee_id = ? AND month = ?')
          .run(share.cents, employeeId, share.month);
        if (expired) {
          this.db
            .prepare('UPDATE batches SET expired = expired + ? WHERE employee_id = ? AND month = ?')
            .run(share.cents, employeeId, share.month);
        }
      }
      this.db
        .prepare('UPDATE redemptions SET cancelled_at = ? WHERE id = ?')
        .run(now, redemption.id);
      return { employeeId, redemptionId, cents: redemption.cents, shares, cancelledAt: now };
    });
  }

  snapshot(employeeId: string): Snapshot {
    assertNonEmpty(employeeId, 'employeeId');
    const now = this.clock();
    this.sweep(employeeId, now);
    const rows = this.db
      .prepare(
        'SELECT month, allocated, spent, expired FROM batches WHERE employee_id = ? ORDER BY month',
      )
      .all(employeeId) as unknown as BatchRow[];
    const batches = rows.map((r) => ({
      month: r.month,
      allocated: r.allocated,
      available: r.allocated - r.spent - r.expired,
      spent: r.spent,
      expired: r.expired,
    }));
    return {
      employeeId,
      totalAvailable: batches.reduce((sum, b) => sum + b.available, 0),
      batches,
    };
  }

  /** Execute a write op with expiry sweep, dedup check, transaction and dedup record. */
  private runWrite<T>(
    employeeId: string,
    key: string,
    op: string,
    request: string,
    now: number,
    fn: () => T,
  ): T {
    this.sweep(employeeId, now);
    const prior = this.db
      .prepare('SELECT op, request, response, created_at FROM dedup_keys WHERE employee_id = ? AND key = ?')
      .get(employeeId, key) as
      | { op: string; request: string; response: string; created_at: number }
      | undefined;
    if (prior && now < prior.created_at + DEDUP_WINDOW_MS) {
      if (prior.op === op && prior.request === request) {
        return JSON.parse(prior.response) as T;
      }
      throw new LedgerError(
        'KEY_CONFLICT',
        `key "${key}" was already used for a different request`,
      );
    }
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db
        .prepare(
          'INSERT OR REPLACE INTO dedup_keys (employee_id, key, op, request, response, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(employeeId, key, op, request, JSON.stringify(result), now);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Move remaining available balance of expired batches into `expired`. */
  private sweep(employeeId: string, now: number): void {
    const rows = this.db
      .prepare('SELECT month FROM batches WHERE employee_id = ?')
      .all(employeeId) as unknown as Array<{ month: string }>;
    for (const row of rows) {
      if (expiryOf(row.month) <= now) {
        this.db
          .prepare(
            'UPDATE batches SET expired = allocated - spent WHERE employee_id = ? AND month = ? AND allocated - spent - expired > 0',
          )
          .run(employeeId, row.month);
      }
    }
  }

  private getBatch(employeeId: string, month: string): BatchRow | undefined {
    return this.db
      .prepare('SELECT month, allocated, spent, expired FROM batches WHERE employee_id = ? AND month = ?')
      .get(employeeId, month) as unknown as BatchRow | undefined;
  }

  /** Batches not yet expired, earliest-expiring (i.e. earliest month) first. */
  private liveBatches(employeeId: string, now: number): BatchRow[] {
    const rows = this.db
      .prepare(
        'SELECT month, allocated, spent, expired FROM batches WHERE employee_id = ? ORDER BY month',
      )
      .all(employeeId) as unknown as BatchRow[];
    return rows.filter((r) => expiryOf(r.month) > now);
  }

  private insertRedemption(
    employeeId: string,
    cents: number,
    shares: MonthShare[],
    now: number,
  ): string {
    const info = this.db
      .prepare('INSERT INTO redemptions (employee_id, cents, created_at) VALUES (?, ?, ?)')
      .run(employeeId, cents, now);
    const id = Number(info.lastInsertRowid);
    const stmt = this.db.prepare(
      'INSERT INTO redemption_shares (redemption_id, month, cents) VALUES (?, ?, ?)',
    );
    for (const share of shares) {
      stmt.run(id, share.month, share.cents);
    }
    return String(id);
  }

  private getRedemption(
    employeeId: string,
    redemptionId: string,
  ): { id: number; cents: number; created_at: number; cancelled_at: number | null } | undefined {
    if (!/^\d+$/.test(redemptionId)) return undefined;
    return this.db
      .prepare('SELECT id, cents, created_at, cancelled_at FROM redemptions WHERE id = ? AND employee_id = ?')
      .get(Number(redemptionId), employeeId) as
      | { id: number; cents: number; created_at: number; cancelled_at: number | null }
      | undefined;
  }

  private getShares(redemptionId: number): MonthShare[] {
    const rows = this.db
      .prepare('SELECT month, cents FROM redemption_shares WHERE redemption_id = ? ORDER BY month')
      .all(redemptionId) as unknown as MonthShare[];
    return rows.map((r) => ({ month: r.month, cents: r.cents }));
  }
}
