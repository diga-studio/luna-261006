import { DatabaseSync } from "node:sqlite";
import type { InstallmentSeed } from "./types.js";

/** 持久化层：每个库文件管理一个计划。 */
export interface StoredConfirmation {
  requestId: string;
  paidAt: number;
  amount: number;
}

export interface StoredPlan {
  startAt: number;
  now: number;
  installments: InstallmentSeed[];
  confirmations: StoredConfirmation[];
}

export class PlanStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS installments (
        idx INTEGER PRIMARY KEY,
        due_at INTEGER NOT NULL,
        principal INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS confirmations (
        request_id TEXT PRIMARY KEY,
        paid_at INTEGER NOT NULL,
        amount INTEGER NOT NULL
      );
    `);
  }

  /** 若库为空则以 seed 初始化；否则忽略 seed 并返回已存数据。 */
  loadOrInit(seed?: { startAt: number; installments: InstallmentSeed[] }): StoredPlan {
    const startRow = this.db.prepare(`SELECT value FROM meta WHERE key = 'start_at'`).get();
    if (startRow === undefined) {
      if (seed === undefined) {
        throw new Error("openPlan: seed is required when creating a new plan");
      }
      this.db.exec("BEGIN");
      try {
        this.db.prepare(`INSERT INTO meta (key, value) VALUES ('start_at', ?)`).run(seed.startAt);
        this.db.prepare(`INSERT INTO meta (key, value) VALUES ('now', ?)`).run(seed.startAt);
        const insert = this.db.prepare(
          `INSERT INTO installments (idx, due_at, principal) VALUES (?, ?, ?)`,
        );
        seed.installments.forEach((inst, idx) => {
          insert.run(idx, inst.dueAt, inst.principal);
        });
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
    const startAt = Number(
      (this.db.prepare(`SELECT value FROM meta WHERE key = 'start_at'`).get() as { value: number })
        .value,
    );
    const now = Number(
      (this.db.prepare(`SELECT value FROM meta WHERE key = 'now'`).get() as { value: number })
        .value,
    );
    const installments = (
      this.db.prepare(`SELECT due_at, principal FROM installments ORDER BY idx`).all() as unknown as {
        due_at: number;
        principal: number;
      }[]
    ).map((row) => ({ dueAt: Number(row.due_at), principal: Number(row.principal) }));
    const confirmations = (
      this.db
        .prepare(`SELECT request_id, paid_at, amount FROM confirmations`)
        .all() as unknown as { request_id: string; paid_at: number; amount: number }[]
    ).map((row) => ({
      requestId: String(row.request_id),
      paidAt: Number(row.paid_at),
      amount: Number(row.amount),
    }));
    return { startAt, now, installments, confirmations };
  }

  /** 幂等插入确认；同 requestId 同内容不重复入账，内容冲突则抛错。 */
  addConfirmation(requestId: string, paidAt: number, amount: number): void {
    const existing = this.db
      .prepare(`SELECT paid_at, amount FROM confirmations WHERE request_id = ?`)
      .get(requestId) as { paid_at: number; amount: number } | undefined;
    if (existing !== undefined) {
      if (Number(existing.paid_at) !== paidAt || Number(existing.amount) !== amount) {
        throw new Error(
          `confirm: requestId ${JSON.stringify(requestId)} already exists with different content`,
        );
      }
      return;
    }
    this.db
      .prepare(`INSERT INTO confirmations (request_id, paid_at, amount) VALUES (?, ?, ?)`)
      .run(requestId, paidAt, amount);
  }

  /** 单调推进观察时刻。 */
  setNow(now: number): void {
    this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'now'`).run(now);
  }

  close(): void {
    this.db.close();
  }
}
