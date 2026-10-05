import { DatabaseSync } from 'node:sqlite';

export interface BatchRow {
  employeeId: string;
  month: string;
  allocated: number;
  /** 未取消兑换的扣款合计。 */
  spent: number;
  key: string;
  createdAtMs: number;
}

export interface RedemptionRow {
  id: string;
  employeeId: string;
  cents: number;
  createdAtMs: number;
  cancelledAtMs: number | null;
}

export interface ShareRow {
  redemptionId: string;
  month: string;
  cents: number;
}

export interface IdempotencyRow {
  employeeId: string;
  key: string;
  op: string;
  requestHash: string;
  resultJson: string;
  createdAtMs: number;
}

/**
 * SQLite 持久化层：只负责表结构与行读写，业务规则在 ledger.ts。
 *
 * 批次不存 available/expired 列：二者由 allocated、spent 与时钟推导，
 * 从而保证到期不依赖任何清理操作。
 */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        employee_id TEXT NOT NULL,
        month TEXT NOT NULL,
        allocated INTEGER NOT NULL,
        spent INTEGER NOT NULL DEFAULT 0,
        key TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (employee_id, month)
      );
      CREATE TABLE IF NOT EXISTS redemptions (
        id TEXT NOT NULL PRIMARY KEY,
        employee_id TEXT NOT NULL,
        cents INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        cancelled_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS redemption_shares (
        redemption_id TEXT NOT NULL REFERENCES redemptions(id),
        month TEXT NOT NULL,
        cents INTEGER NOT NULL,
        PRIMARY KEY (redemption_id, month)
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        employee_id TEXT NOT NULL,
        key TEXT NOT NULL,
        op TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (employee_id, key, op, request_hash)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 在 IMMEDIATE 事务中执行 fn，失败回滚，保证不留部分写入。 */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getBatch(employeeId: string, month: string): BatchRow | null {
    const row = this.db
      .prepare(
        'SELECT employee_id, month, allocated, spent, key, created_at_ms FROM batches WHERE employee_id = ? AND month = ?',
      )
      .get(employeeId, month) as Record<string, unknown> | undefined;
    return row ? mapBatch(row) : null;
  }

  listBatches(employeeId: string): BatchRow[] {
    const rows = this.db
      .prepare(
        'SELECT employee_id, month, allocated, spent, key, created_at_ms FROM batches WHERE employee_id = ? ORDER BY month ASC',
      )
      .all(employeeId) as unknown as Record<string, unknown>[];
    return rows.map(mapBatch);
  }

  insertBatch(row: BatchRow): void {
    this.db
      .prepare(
        'INSERT INTO batches (employee_id, month, allocated, spent, key, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.employeeId, row.month, row.allocated, row.spent, row.key, row.createdAtMs);
  }

  addSpent(employeeId: string, month: string, delta: number): void {
    this.db
      .prepare('UPDATE batches SET spent = spent + ? WHERE employee_id = ? AND month = ?')
      .run(delta, employeeId, month);
  }

  insertRedemption(row: RedemptionRow): void {
    this.db
      .prepare(
        'INSERT INTO redemptions (id, employee_id, cents, created_at_ms, cancelled_at_ms) VALUES (?, ?, ?, ?, ?)',
      )
      .run(row.id, row.employeeId, row.cents, row.createdAtMs, row.cancelledAtMs);
  }

  getRedemption(id: string): RedemptionRow | null {
    const row = this.db
      .prepare(
        'SELECT id, employee_id, cents, created_at_ms, cancelled_at_ms FROM redemptions WHERE id = ?',
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapRedemption(row) : null;
  }

  markCancelled(id: string, cancelledAtMs: number): void {
    this.db
      .prepare('UPDATE redemptions SET cancelled_at_ms = ? WHERE id = ?')
      .run(cancelledAtMs, id);
  }

  insertShare(row: ShareRow): void {
    this.db
      .prepare('INSERT INTO redemption_shares (redemption_id, month, cents) VALUES (?, ?, ?)')
      .run(row.redemptionId, row.month, row.cents);
  }

  listShares(redemptionId: string): ShareRow[] {
    const rows = this.db
      .prepare(
        'SELECT redemption_id, month, cents FROM redemption_shares WHERE redemption_id = ? ORDER BY month ASC',
      )
      .all(redemptionId) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      redemptionId: r.redemption_id as string,
      month: r.month as string,
      cents: r.cents as number,
    }));
  }

  getIdempotency(employeeId: string, key: string, op: string, requestHash: string): IdempotencyRow | null {
    const row = this.db
      .prepare(
        'SELECT employee_id, key, op, request_hash, result_json, created_at_ms FROM idempotency_keys WHERE employee_id = ? AND key = ? AND op = ? AND request_hash = ?',
      )
      .get(employeeId, key, op, requestHash) as Record<string, unknown> | undefined;
    return row
      ? {
          employeeId: row.employee_id as string,
          key: row.key as string,
          op: row.op as string,
          requestHash: row.request_hash as string,
          resultJson: row.result_json as string,
          createdAtMs: row.created_at_ms as number,
        }
      : null;
  }

  putIdempotency(row: IdempotencyRow): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO idempotency_keys (employee_id, key, op, request_hash, result_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.employeeId, row.key, row.op, row.requestHash, row.resultJson, row.createdAtMs);
  }
}

function mapBatch(row: Record<string, unknown>): BatchRow {
  return {
    employeeId: row.employee_id as string,
    month: row.month as string,
    allocated: row.allocated as number,
    spent: row.spent as number,
    key: row.key as string,
    createdAtMs: row.created_at_ms as number,
  };
}

function mapRedemption(row: Record<string, unknown>): RedemptionRow {
  return {
    id: row.id as string,
    employeeId: row.employee_id as string,
    cents: row.cents as number,
    createdAtMs: row.created_at_ms as number,
    cancelledAtMs: (row.cancelled_at_ms as number | null) ?? null,
  };
}
