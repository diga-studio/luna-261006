import type { DatabaseSync } from "node:sqlite";
import { assertValidMonth } from "./input";
import {
  BatchInfo,
  BatchStatus,
  CENTS_PER_PV_BY_DEPTH,
  MAX_ADVANCE_PER_CALL,
  MAX_DEPTH,
  MemberResult,
  MonthKey,
  REVIEW_THRESHOLD_CENTS,
} from "./types";

interface BatchRow {
  batch_id: string;
  month: string;
  status: string;
  total_count: number;
  done_count: number;
}

export class SettlementEngine {
  // Frozen batch data is immutable once created, so it can be cached in
  // memory for the lifetime of this process. After a restart the cache is
  // simply rebuilt from SQLite; correctness never depends on it.
  private readonly snapshotCache = new Map<
    string,
    { childrenOf: Map<string, string[]>; pvOf: Map<string, number> }
  >();

  constructor(private readonly db: DatabaseSync) {}

  initiate(month: MonthKey): BatchInfo {
    assertValidMonth(month);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.findBatch(month);
      if (existing) {
        this.db.exec("COMMIT");
        return existing;
      }
      const batchId = `B-${month}`;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO batches (batch_id, month, status, total_count, done_count, created_at)
           VALUES (?, ?, 'processing',
                   (SELECT COUNT(*) FROM members), 0, ?)`
        )
        .run(batchId, month, now);
      this.db
        .prepare(
          `INSERT INTO batch_members (batch_id, member_id, seq, status, commission_cents, needs_review)
           SELECT ?, member_id, seq, 'pending', NULL, NULL FROM members`
        )
        .run(batchId);
      this.db
        .prepare(
          `INSERT INTO batch_edges (batch_id, member_id, sponsor_id)
           SELECT ?, member_id, sponsor_id FROM members`
        )
        .run(batchId);
      this.db
        .prepare(
          `INSERT INTO batch_pv (batch_id, member_id, pv)
           SELECT ?, member_id, pv FROM monthly_pv WHERE month = ?`
        )
        .run(batchId, month);
      const created = this.mustFindBatch(month);
      if (created.totalCount === 0) {
        this.db
          .prepare(`UPDATE batches SET status = 'completed' WHERE batch_id = ?`)
          .run(batchId);
      }
      const info = this.mustFindBatch(month);
      this.db.exec("COMMIT");
      return info;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  advance(month: MonthKey, maxMembers: number = MAX_ADVANCE_PER_CALL): BatchInfo {
    assertValidMonth(month);
    if (!Number.isInteger(maxMembers) || maxMembers < 1) {
      throw new Error("maxMembers must be a positive integer");
    }
    const limit = Math.min(maxMembers, MAX_ADVANCE_PER_CALL);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const batch = this.mustFindBatch(month);
      if (batch.status === "completed") {
        this.db.exec("COMMIT");
        return batch;
      }
      const pending = this.db
        .prepare(
          `SELECT member_id AS id FROM batch_members
           WHERE batch_id = ? AND status = 'pending'
           ORDER BY seq LIMIT ?`
        )
        .all(batch.batchId, limit)
        .map((r) => r.id as string);

      if (pending.length > 0) {
        const snapshot = this.getSnapshot(batch.batchId);
        const finish = this.db.prepare(
          `UPDATE batch_members
           SET status = 'done', commission_cents = ?, needs_review = ?
           WHERE batch_id = ? AND member_id = ? AND status = 'pending'`
        );
        for (const memberId of pending) {
          const cents = this.computeCommission(
            memberId,
            snapshot.childrenOf,
            snapshot.pvOf
          );
          const review = cents > REVIEW_THRESHOLD_CENTS ? 1 : 0;
          finish.run(cents, review, batch.batchId, memberId);
        }
        this.db
          .prepare(
            `UPDATE batches
             SET done_count = done_count + ?,
                 status = CASE WHEN done_count + ? >= total_count
                               THEN 'completed' ELSE status END
             WHERE batch_id = ?`
          )
          .run(pending.length, pending.length, batch.batchId);
      }
      const info = this.mustFindBatch(month);
      this.db.exec("COMMIT");
      return info;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getStatus(month: MonthKey): BatchInfo | null {
    assertValidMonth(month);
    return this.findBatch(month);
  }

  getMemberResult(month: MonthKey, memberId: string): MemberResult | null {
    assertValidMonth(month);
    const batch = this.findBatch(month);
    if (!batch || batch.status !== "completed") {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT commission_cents AS c, needs_review AS r
         FROM batch_members WHERE batch_id = ? AND member_id = ?`
      )
      .get(batch.batchId, memberId);
    if (!row) {
      return null;
    }
    return {
      memberId,
      commissionCents: row.c as number,
      needsReview: (row.r as number) === 1,
    };
  }

  getAllResults(month: MonthKey): MemberResult[] | null {
    assertValidMonth(month);
    const batch = this.findBatch(month);
    if (!batch || batch.status !== "completed") {
      return null;
    }
    return this.db
      .prepare(
        `SELECT member_id AS id, commission_cents AS c, needs_review AS r
         FROM batch_members WHERE batch_id = ? ORDER BY seq`
      )
      .all(batch.batchId)
      .map((row) => ({
        memberId: row.id as string,
        commissionCents: row.c as number,
        needsReview: (row.r as number) === 1,
      }));
  }

  private computeCommission(
    memberId: string,
    childrenOf: Map<string, string[]>,
    pvOf: Map<string, number>
  ): number {
    let cents = 0;
    const stack: Array<{ id: string; depth: number }> = [];
    for (const child of childrenOf.get(memberId) ?? []) {
      stack.push({ id: child, depth: 1 });
    }
    while (stack.length > 0) {
      const { id, depth } = stack.pop()!;
      const pv = pvOf.get(id) ?? 0;
      if (pv > 0) {
        cents += pv * CENTS_PER_PV_BY_DEPTH[depth];
      }
      if (depth < MAX_DEPTH) {
        for (const child of childrenOf.get(id) ?? []) {
          stack.push({ id: child, depth: depth + 1 });
        }
      }
    }
    return cents;
  }

  private loadChildren(batchId: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    const rows = this.db
      .prepare(
        `SELECT member_id AS id, sponsor_id AS s
         FROM batch_edges WHERE batch_id = ? AND sponsor_id IS NOT NULL`
      )
      .all(batchId);
    for (const row of rows) {
      const sponsor = row.s as string;
      const list = map.get(sponsor);
      if (list) {
        list.push(row.id as string);
      } else {
        map.set(sponsor, [row.id as string]);
      }
    }
    return map;
  }

  private loadPv(batchId: string): Map<string, number> {
    const map = new Map<string, number>();
    const rows = this.db
      .prepare(`SELECT member_id AS id, pv FROM batch_pv WHERE batch_id = ?`)
      .all(batchId);
    for (const row of rows) {
      map.set(row.id as string, row.pv as number);
    }
    return map;
  }

  private getSnapshot(batchId: string): {
    childrenOf: Map<string, string[]>;
    pvOf: Map<string, number>;
  } {
    let snapshot = this.snapshotCache.get(batchId);
    if (!snapshot) {
      snapshot = {
        childrenOf: this.loadChildren(batchId),
        pvOf: this.loadPv(batchId),
      };
      this.snapshotCache.set(batchId, snapshot);
    }
    return snapshot;
  }

  private findBatch(month: MonthKey): BatchInfo | null {
    const row = this.db
      .prepare(
        `SELECT batch_id, month, status, total_count, done_count
         FROM batches WHERE month = ?`
      )
      .get(month) as unknown as BatchRow | undefined;
    return row ? toBatchInfo(row) : null;
  }

  private mustFindBatch(month: MonthKey): BatchInfo {
    const info = this.findBatch(month);
    if (!info) {
      throw new Error(`no settlement batch for month ${month}`);
    }
    return info;
  }
}

function toBatchInfo(row: BatchRow): BatchInfo {
  return {
    batchId: row.batch_id,
    month: row.month,
    status: row.status as BatchStatus,
    totalCount: row.total_count,
    doneCount: row.done_count,
  };
}
