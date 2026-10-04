import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  member_id TEXT PRIMARY KEY,
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
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  total INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS batch_members (
  batch_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_members_pending
  ON batch_members (batch_id, settled, seq);
CREATE TABLE IF NOT EXISTS batch_edges (
  batch_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  sponsor_id TEXT,
  PRIMARY KEY (batch_id, member_id)
);
CREATE TABLE IF NOT EXISTS batch_pv (
  batch_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  pv INTEGER NOT NULL,
  PRIMARY KEY (batch_id, member_id)
);
CREATE TABLE IF NOT EXISTS results (
  batch_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  commission_cents INTEGER NOT NULL,
  needs_review INTEGER NOT NULL,
  PRIMARY KEY (batch_id, member_id)
);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(SCHEMA);
  return db;
}
