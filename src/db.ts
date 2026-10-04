import { DatabaseSync } from 'node:sqlite';

export const ROUND_MS = 24 * 60 * 60 * 1000;

/** 打开（或创建）数据库并建表 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id   TEXT PRIMARY KEY,
      status      TEXT NOT NULL,              -- open | approved | rejected | expired
      stage_index INTEGER NOT NULL,
      round       TEXT NOT NULL,              -- normal | escalation
      deadline    INTEGER NOT NULL,           -- 当前轮截止时刻（毫秒）
      stages_json TEXT NOT NULL               -- StageSpec[] 的 JSON
    );
    CREATE TABLE IF NOT EXISTS votes (
      ticket_id   TEXT NOT NULL,
      stage_index INTEGER NOT NULL,
      round       TEXT NOT NULL,
      approver    TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      verdict     TEXT NOT NULL,              -- approve | reject
      PRIMARY KEY (ticket_id, stage_index, round, approver)
    );
    CREATE TABLE IF NOT EXISTS decisions (
      ticket_id   TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      conclusion  TEXT NOT NULL,
      PRIMARY KEY (ticket_id, decision_id)
    );
  `);
  return db;
}

/** 在 IMMEDIATE 事务中执行 fn，保证多步写入原子生效 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
