import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import { computeCommissionCents, REVIEW_THRESHOLD_CENTS } from './calc.js';
import type { BatchInfo, BatchStatus, MemberResult } from './types.js';

const MAX_ADVANCE_PER_CALL = 200;

interface BatchRow {
  batch_id: string;
  month: string;
  status: string;
  total: number;
  done: number;
}

interface SnapshotIndex {
  childrenOf: Map<string, string[]>;
  pvOf: Map<string, number>;
}

function toBatchInfo(row: BatchRow): BatchInfo {
  return {
    batchId: row.batch_id,
    month: row.month,
    status: row.status as BatchStatus,
    total: row.total,
    done: row.done,
  };
}

export class CommissionLedger {
  private readonly db: DatabaseSync;
  private readonly indexCache = new Map<string, SnapshotIndex>();

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  addMember(memberId: string, sponsorId: string | null = null): void {
    assertNonEmpty(memberId, 'memberId');
    if (sponsorId !== null) assertNonEmpty(sponsorId, 'sponsorId');
    if (sponsorId === memberId) throw new Error('member cannot sponsor itself');
    this.db
      .prepare(
        `INSERT INTO members (member_id, sponsor_id) VALUES (?, ?)
         ON CONFLICT(member_id) DO UPDATE SET sponsor_id = excluded.sponsor_id`,
      )
      .run(memberId, sponsorId);
  }

  setMonthlyPv(memberId: string, month: string, pv: number): void {
    assertNonEmpty(memberId, 'memberId');
    assertMonth(month);
    if (!Number.isInteger(pv) || pv < 0 || pv > 99999) {
      throw new Error('pv must be an integer between 0 and 99999');
    }
    const member = this.db
      .prepare('SELECT member_id FROM members WHERE member_id = ?')
      .get(memberId);
    if (!member) throw new Error(`unknown member: ${memberId}`);
    this.db
      .prepare(
        `INSERT INTO monthly_pv (member_id, month, pv) VALUES (?, ?, ?)
         ON CONFLICT(member_id, month) DO UPDATE SET pv = excluded.pv`,
      )
      .run(memberId, month, pv);
  }

  startSettlement(month: string): BatchInfo {
    assertMonth(month);
    return this.inTransaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM batches WHERE month = ?')
        .get(month) as BatchRow | undefined;
      if (existing) return toBatchInfo(existing);

      const batchId = `${month}:${randomUUID()}`;
      const total = (
        this.db.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }
      ).n;
      this.db
        .prepare(
          `INSERT INTO batches (batch_id, month, status, total, done, created_at)
           VALUES (?, ?, 'processing', ?, 0, ?)`,
        )
        .run(batchId, month, total, new Date().toISOString());
      this.db
        .prepare(
          `INSERT INTO batch_members (batch_id, member_id, seq)
           SELECT ?, member_id, ROW_NUMBER() OVER (ORDER BY member_id) FROM members`,
        )
        .run(batchId);
      this.db
        .prepare(
          `INSERT INTO batch_edges (batch_id, member_id, sponsor_id)
           SELECT ?, member_id, sponsor_id FROM members`,
        )
        .run(batchId);
      this.db
        .prepare(
          `INSERT INTO batch_pv (batch_id, member_id, pv)
           SELECT ?, m.member_id, COALESCE(p.pv, 0)
           FROM members m
           LEFT JOIN monthly_pv p ON p.member_id = m.member_id AND p.month = ?`,
        )
        .run(batchId, month);
      return this.requireBatch(batchId);
    });
  }

  advance(batchId: string, maxCount = MAX_ADVANCE_PER_CALL): BatchInfo {
    if (!Number.isInteger(maxCount) || maxCount < 1) {
      throw new Error('maxCount must be a positive integer');
    }
    const limit = Math.min(maxCount, MAX_ADVANCE_PER_CALL);
    return this.inTransaction(() => {
      const batch = this.getBatch(batchId);
      if (!batch) throw new Error(`unknown batch: ${batchId}`);
      if (batch.status === 'completed') return batch;

      const pending = this.db
        .prepare(
          `SELECT member_id FROM batch_members
           WHERE batch_id = ? AND settled = 0 ORDER BY seq LIMIT ?`,
        )
        .all(batchId, limit) as Array<{ member_id: string }>;

      if (pending.length > 0) {
        const index = this.snapshotIndex(batchId);
        const insertResult = this.db.prepare(
          `INSERT INTO results (batch_id, member_id, commission_cents, needs_review)
           VALUES (?, ?, ?, ?)`,
        );
        const markSettled = this.db.prepare(
          'UPDATE batch_members SET settled = 1 WHERE batch_id = ? AND member_id = ?',
        );
        for (const { member_id: memberId } of pending) {
          const cents = computeCommissionCents(memberId, index.childrenOf, index.pvOf);
          insertResult.run(batchId, memberId, cents, cents > REVIEW_THRESHOLD_CENTS ? 1 : 0);
          markSettled.run(batchId, memberId);
        }
        const done = batch.done + pending.length;
        const status = done >= batch.total ? 'completed' : 'processing';
        this.db
          .prepare('UPDATE batches SET done = ?, status = ? WHERE batch_id = ?')
          .run(done, status, batchId);
      }
      return this.requireBatch(batchId);
    });
  }

  getBatch(batchId: string): BatchInfo | null {
    const row = this.db
      .prepare('SELECT * FROM batches WHERE batch_id = ?')
      .get(batchId) as BatchRow | undefined;
    return row ? toBatchInfo(row) : null;
  }

  getBatchByMonth(month: string): BatchInfo | null {
    const row = this.db
      .prepare('SELECT * FROM batches WHERE month = ?')
      .get(month) as BatchRow | undefined;
    return row ? toBatchInfo(row) : null;
  }

  getResult(batchId: string, memberId: string): MemberResult | null {
    this.requireCompleted(batchId);
    const row = this.db
      .prepare(
        'SELECT member_id, commission_cents, needs_review FROM results WHERE batch_id = ? AND member_id = ?',
      )
      .get(batchId, memberId) as
      | { member_id: string; commission_cents: number; needs_review: number }
      | undefined;
    if (!row) return null;
    return {
      memberId: row.member_id,
      commissionCents: row.commission_cents,
      needsReview: row.needs_review === 1,
    };
  }

  getAllResults(batchId: string): MemberResult[] {
    this.requireCompleted(batchId);
    const rows = this.db
      .prepare(
        'SELECT member_id, commission_cents, needs_review FROM results WHERE batch_id = ? ORDER BY member_id',
      )
      .all(batchId) as Array<{
      member_id: string;
      commission_cents: number;
      needs_review: number;
    }>;
    return rows.map((row) => ({
      memberId: row.member_id,
      commissionCents: row.commission_cents,
      needsReview: row.needs_review === 1,
    }));
  }

  close(): void {
    this.db.close();
    this.indexCache.clear();
  }

  private requireBatch(batchId: string): BatchInfo {
    const batch = this.getBatch(batchId);
    if (!batch) throw new Error(`unknown batch: ${batchId}`);
    return batch;
  }

  private requireCompleted(batchId: string): BatchInfo {
    const batch = this.requireBatch(batchId);
    if (batch.status !== 'completed') {
      throw new Error(`batch ${batchId} is still processing; results are not yet available`);
    }
    return batch;
  }

  private snapshotIndex(batchId: string): SnapshotIndex {
    const cached = this.indexCache.get(batchId);
    if (cached) return cached;
    const childrenOf = new Map<string, string[]>();
    const edges = this.db
      .prepare('SELECT member_id, sponsor_id FROM batch_edges WHERE batch_id = ?')
      .all(batchId) as Array<{ member_id: string; sponsor_id: string | null }>;
    for (const edge of edges) {
      if (edge.sponsor_id === null) continue;
      const list = childrenOf.get(edge.sponsor_id);
      if (list) list.push(edge.member_id);
      else childrenOf.set(edge.sponsor_id, [edge.member_id]);
    }
    const pvOf = new Map<string, number>();
    const pvs = this.db
      .prepare('SELECT member_id, pv FROM batch_pv WHERE batch_id = ?')
      .all(batchId) as Array<{ member_id: string; pv: number }>;
    for (const { member_id, pv } of pvs) pvOf.set(member_id, pv);
    const index: SnapshotIndex = { childrenOf, pvOf };
    this.indexCache.set(batchId, index);
    return index;
  }

  private inTransaction<T>(fn: () => T): T {
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
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function assertMonth(month: string): void {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error('month must be in YYYY-MM format');
  }
}
