import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS site (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS probe (
  site_pk INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  status INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS probe_site_ts ON probe (site_pk, ts);
CREATE TABLE IF NOT EXISTS daily (
  site_pk INTEGER NOT NULL,
  day_start INTEGER NOT NULL,
  online_ms INTEGER NOT NULL DEFAULT 0,
  offline_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_pk, day_start)
);
CREATE TABLE IF NOT EXISTS hourly (
  site_pk INTEGER NOT NULL,
  hour_start INTEGER NOT NULL,
  online_ms INTEGER NOT NULL DEFAULT 0,
  offline_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_pk, hour_start)
);
`;

/**
 * Opens (creating when needed) the SQLite database at `path` and ensures
 * the schema exists. Use ":memory:" for an in-memory database.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec(SCHEMA);
  return db;
}
