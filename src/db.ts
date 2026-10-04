import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL + NORMAL sync: committed transactions survive a process crash
  // (recovery requirement) while avoiding an fsync per statement.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL UNIQUE,
      sponsor_id TEXT
    );
    CREATE TABLE IF NOT EXISTS monthly_pv (
      member_id TEXT NOT NULL,
      month TEXT NOT NULL,
      pv INTEGER NOT NULL,
      PRIMARY KEY (member_id, month)
    );
    CREATE TABLE IF NOT EXISTS batches (
      batch_id TEXT PRIMARY KEY,
      month TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      total_count INTEGER NOT NULL,
      done_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS batch_members (
      batch_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      status TEXT NOT NULL,
      commission_cents INTEGER,
      needs_review INTEGER,
      PRIMARY KEY (batch_id, member_id)
    );
    CREATE TABLE IF NOT EXISTS batch_edges (
      batch_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      sponsor_id TEXT,
      PRIMARY KEY (batch_id, member_id)
    );
    CREATE INDEX IF NOT EXISTS idx_batch_edges_sponsor
      ON batch_edges (batch_id, sponsor_id);
    CREATE TABLE IF NOT EXISTS batch_pv (
      batch_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      pv INTEGER NOT NULL,
      PRIMARY KEY (batch_id, member_id)
    );
  `);
}
