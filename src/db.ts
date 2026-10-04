import { DatabaseSync } from 'node:sqlite';

/** How long a probe conclusion stays valid after it finishes. */
export const VALIDITY_MS = 10 * 60 * 1000;
/** A day is fixed at 24 hours. */
export const DAY_MS = 24 * 60 * 60 * 1000;
/** Probe detail retention window. */
export const RETENTION_MS = 90 * DAY_MS;

const META_CLEANUP_HORIZON = 'cleanup_horizon';

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  // auto_vacuum must be set before any table is created; no-op afterwards.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA auto_vacuum = INCREMENTAL;
    CREATE TABLE IF NOT EXISTS sites (
      site_id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS probes (
      site_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      online INTEGER NOT NULL,
      PRIMARY KEY (site_id, ts)
    );
    CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL,
      start INTEGER NOT NULL,
      end INTEGER NOT NULL,
      state INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_segments_site_start
      ON segments (site_id, start);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
  return db;
}

export function getCleanupHorizon(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(META_CLEANUP_HORIZON) as { value: number } | undefined;
  return row ? Number(row.value) : 0;
}

export function setCleanupHorizon(db: DatabaseSync, horizon: number): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(META_CLEANUP_HORIZON, horizon);
}
