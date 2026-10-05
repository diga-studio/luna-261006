import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';

export interface Row {
  [column: string]: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  camera_index INTEGER NOT NULL,
  camera TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  completed_attempt_id TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  leased_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  result_path TEXT,
  result_sha256 TEXT
);
`;

/**
 * Thin synchronous wrapper around a sql.js database persisted to a file.
 * Every mutating statement flushes the full database image back to disk
 * (write to a temp file, then rename) so the on-disk state is always
 * a consistent snapshot.
 */
export class Database {
  private sqlJs!: SqlJsStatic;
  private db!: SqlJsDatabase;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async open(): Promise<void> {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const wasmBinary = readFileSync(wasmPath);
    this.sqlJs = await initSqlJs({ wasmBinary });
    const existing = existsSync(this.filePath) ? readFileSync(this.filePath) : null;
    this.db = existing ? new this.sqlJs.Database(existing) : new this.sqlJs.Database();
    this.db.run(SCHEMA);
    this.flush();
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params);
    this.flush();
  }

  query(sql: string, params: unknown[] = []): Row[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: Row[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  queryOne(sql: string, params: unknown[] = []): Row | undefined {
    return this.query(sql, params)[0];
  }

  /** Runs fn inside a transaction, flushing once at the end. */
  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN');
    try {
      const result = fn();
      this.db.run('COMMIT');
      this.flush();
      return result;
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  runInTransaction(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params);
  }

  flush(): void {
    const data = this.db.export();
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = join(dirname(this.filePath), `.${Date.now()}-${process.pid}.tmp`);
    writeFileSync(tmp, data);
    renameSync(tmp, this.filePath);
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}
