import { DatabaseSync } from "node:sqlite";

export interface TaskRow {
  id: number;
  path: string;
  status: string;
  read_offset: number;
  header_done: number;
  next_record_no: number;
  processed: number;
  succeeded: number;
  failed: number;
}

export class ImportDb {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        read_offset INTEGER NOT NULL DEFAULT 0,
        header_done INTEGER NOT NULL DEFAULT 0,
        next_record_no INTEGER NOT NULL DEFAULT 1,
        processed INTEGER NOT NULL DEFAULT 0,
        succeeded INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS results (
        task_id INTEGER NOT NULL,
        record_no INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        external_id TEXT,
        revision INTEGER,
        error TEXT,
        PRIMARY KEY (task_id, record_no)
      );
      CREATE TABLE IF NOT EXISTS cases (
        external_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
    `);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
