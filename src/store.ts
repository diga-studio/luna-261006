import { DatabaseSync } from "node:sqlite";
import type { Confirmation, PlanSeed } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS installments (
  idx INTEGER PRIMARY KEY,
  principal INTEGER NOT NULL,
  due_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS confirmations (
  request_id TEXT PRIMARY KEY,
  paid_at INTEGER NOT NULL,
  amount INTEGER NOT NULL
);
`;

/** SQLite 持久化层：每个库文件管理一个计划。 */
export class PlanStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  /** 库中是否已有计划数据。 */
  hasPlan(): boolean {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'startAt'")
      .get() as { value: number } | undefined;
    return row !== undefined;
  }

  /** 用种子初始化一个全新计划。观察时刻初始为 startAt。 */
  initialize(seed: PlanSeed): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('startAt', ?)")
        .run(seed.startAt);
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('now', ?)")
        .run(seed.startAt);
      const stmt = this.db.prepare(
        "INSERT INTO installments (idx, principal, due_at) VALUES (?, ?, ?)",
      );
      seed.installments.forEach((inst, idx) => {
        stmt.run(idx, inst.principal, inst.dueAt);
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getStartAt(): number {
    return this.getMeta("startAt");
  }

  getNow(): number {
    return this.getMeta("now");
  }

  setNow(now: number): void {
    this.db
      .prepare("UPDATE meta SET value = ? WHERE key = 'now'")
      .run(now);
  }

  private getMeta(key: string): number {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: number } | undefined;
    if (row === undefined) {
      throw new Error(`plan meta missing: ${key}`);
    }
    return row.value;
  }

  getInstallments(): { principal: number; dueAt: number }[] {
    const rows = this.db
      .prepare("SELECT principal, due_at FROM installments ORDER BY idx")
      .all() as { principal: number; due_at: number }[];
    return rows.map((r) => ({ principal: r.principal, dueAt: r.due_at }));
  }

  getConfirmations(): Confirmation[] {
    const rows = this.db
      .prepare(
        "SELECT request_id, paid_at, amount FROM confirmations ORDER BY paid_at, request_id",
      )
      .all() as { request_id: string; paid_at: number; amount: number }[];
    return rows.map((r) => ({
      requestId: r.request_id,
      paidAt: r.paid_at,
      amount: r.amount,
    }));
  }

  getConfirmation(requestId: string): Confirmation | null {
    const row = this.db
      .prepare(
        "SELECT request_id, paid_at, amount FROM confirmations WHERE request_id = ?",
      )
      .get(requestId) as
      | { request_id: string; paid_at: number; amount: number }
      | undefined;
    if (row === undefined) return null;
    return { requestId: row.request_id, paidAt: row.paid_at, amount: row.amount };
  }

  insertConfirmation(conf: Confirmation): void {
    this.db
      .prepare(
        "INSERT INTO confirmations (request_id, paid_at, amount) VALUES (?, ?, ?)",
      )
      .run(conf.requestId, conf.paidAt, conf.amount);
  }

  close(): void {
    this.db.close();
  }
}
