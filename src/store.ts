/** SQLite-backed persistence of batch and per-file task records. */

import { openDatabase, SqliteDatabase } from "./sqlite";
import { BatchConflictError } from "./errors";

export interface BatchRecord {
  batchId: string;
  /** sha256 hex of the 32-byte key, to verify retries use the same key. */
  keyHash: string;
  /** sha256 hex over the canonical manifest, to verify retries. */
  manifestHash: string;
  createdAt: number;
}

export interface FileRecord {
  path: string;
  done: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  batch_id TEXT NOT NULL,
  path TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, path)
);
`;

export class TaskStore {
  private readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec(SCHEMA);
  }

  /**
   * Insert batch + file rows if absent. If the batch already exists, verify
   * key and manifest match the original submission; otherwise throw.
   */
  ensureBatch(record: BatchRecord, paths: string[]): BatchRecord {
    const existing = this.getBatch(record.batchId);
    if (existing) {
      if (existing.keyHash !== record.keyHash) {
        throw new BatchConflictError(
          `batch ${record.batchId} was submitted with a different key`
        );
      }
      if (existing.manifestHash !== record.manifestHash) {
        throw new BatchConflictError(
          `batch ${record.batchId} was submitted with a different file manifest`
        );
      }
      return existing;
    }
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO batches (batch_id, key_hash, manifest_hash, created_at) VALUES (?, ?, ?, ?)"
        )
        .run(record.batchId, record.keyHash, record.manifestHash, record.createdAt);
      const insertFile = this.db.prepare(
        "INSERT INTO files (batch_id, path, done) VALUES (?, ?, 0)"
      );
      for (const p of paths) {
        insertFile.run(record.batchId, p);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return record;
  }

  getBatch(batchId: string): BatchRecord | null {
    const row = this.db
      .prepare(
        "SELECT batch_id, key_hash, manifest_hash, created_at FROM batches WHERE batch_id = ?"
      )
      .get(batchId);
    if (!row) return null;
    return {
      batchId: row.batch_id as string,
      keyHash: row.key_hash as string,
      manifestHash: row.manifest_hash as string,
      createdAt: row.created_at as number,
    };
  }

  listFiles(batchId: string): FileRecord[] {
    return this.db
      .prepare("SELECT path, done FROM files WHERE batch_id = ? ORDER BY path")
      .all(batchId)
      .map((row) => ({ path: row.path as string, done: row.done === 1 }));
  }

  markDone(batchId: string, path: string): void {
    this.db
      .prepare("UPDATE files SET done = 1 WHERE batch_id = ? AND path = ?")
      .run(batchId, path);
  }

  close(): void {
    this.db.close();
  }
}
