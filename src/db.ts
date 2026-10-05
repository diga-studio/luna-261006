import { DatabaseSync } from "node:sqlite";

export interface BatchRow {
  id: string;
  priority: number;
  content_hash: string;
  seq: number;
}

export interface TaskRow {
  id: number;
  batch_id: string;
  camera_seq: number;
  camera_id: string;
  status: string;
  current_attempt_id: number | null;
  completed_attempt_id: number | null;
  artifact_path: string | null;
}

export interface AttemptRow {
  id: number;
  task_id: number;
  leased_at: number;
  expires_at: number;
}

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      priority INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      seq INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL REFERENCES batches(id),
      camera_seq INTEGER NOT NULL,
      camera_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      current_attempt_id INTEGER,
      completed_attempt_id INTEGER,
      artifact_path TEXT
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      leased_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}
