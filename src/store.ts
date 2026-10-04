import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  header_done INTEGER NOT NULL DEFAULT 0,
  next_record_no INTEGER NOT NULL DEFAULT 1,
  completed INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cases (
  external_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  task_id INTEGER NOT NULL,
  record_no INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  external_id TEXT NOT NULL,
  revision INTEGER,
  error TEXT,
  PRIMARY KEY (task_id, record_no)
);
`;

/** 打开（必要时创建）导入库数据库并建表。 */
export function openStore(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA synchronous = FULL");
  db.exec(SCHEMA);
  return db;
}
