import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** SQLite 持久化：批次记录与逐文件完成记录。 */

export interface BatchRow {
  batchId: string;
  manifestJson: string;
  keyFingerprint: string;
}

/** 密钥指纹仅用于检测“同一批次标识换了密钥”的误用，无法反推密钥。 */
function keyFingerprintOf(key: Buffer): string {
  return createHmac('sha256', key)
    .update('sentinelvault-key-check-v1')
    .digest('hex');
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        batch_id TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        batch_id TEXT NOT NULL,
        path TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (batch_id, path)
      );
    `);
  }

  /** 已存在则校验清单与密钥指纹一致；不存在则创建。 */
  ensureBatch(batchId: string, files: string[], key: Buffer): void {
    const manifestJson = JSON.stringify(files);
    const fingerprint = keyFingerprintOf(key);
    const existing = this.getBatch(batchId);
    if (existing !== null) {
      if (existing.manifestJson !== manifestJson) {
        throw new Error(`batch ${batchId} already exists with a different manifest`);
      }
      if (existing.keyFingerprint !== fingerprint) {
        throw new Error(`batch ${batchId} already exists with a different key`);
      }
      return;
    }
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO batches (batch_id, manifest_json, key_fingerprint, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(batchId, manifestJson, fingerprint, now);
      const insertFile = this.db.prepare(
        'INSERT INTO files (batch_id, path, done, updated_at) VALUES (?, ?, 0, ?)',
      );
      for (const path of files) {
        insertFile.run(batchId, path, now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getBatch(batchId: string): BatchRow | null {
    const row = this.db
      .prepare(
        'SELECT batch_id, manifest_json, key_fingerprint FROM batches WHERE batch_id = ?',
      )
      .get(batchId) as
      | { batch_id: string; manifest_json: string; key_fingerprint: string }
      | undefined;
    if (row === undefined) return null;
    return {
      batchId: row.batch_id,
      manifestJson: row.manifest_json,
      keyFingerprint: row.key_fingerprint,
    };
  }

  markDone(batchId: string, path: string): void {
    this.db
      .prepare(
        'UPDATE files SET done = 1, updated_at = ? WHERE batch_id = ? AND path = ?',
      )
      .run(Date.now(), batchId, path);
  }

  close(): void {
    this.db.close();
  }
}
