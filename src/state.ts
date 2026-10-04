import { DatabaseSync } from "node:sqlite";
import { DEDUP_WINDOW_MS } from "./types";

export interface PendingRow {
  receipt: number;
  deviceId: string;
  sampleAt: number;
  payload: Buffer;
}

const COMMITTED_SIZE_KEY = "committed_size";

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending (
        receipt INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        sample_at INTEGER NOT NULL,
        payload BLOB NOT NULL,
        accepted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_due ON pending(sample_at, receipt);
      CREATE TABLE IF NOT EXISTS dedup (
        device_id TEXT NOT NULL,
        sample_at INTEGER NOT NULL,
        receipt INTEGER NOT NULL,
        first_accepted_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, sample_at)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getCommittedSize(): number {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(COMMITTED_SIZE_KEY) as { value: string } | undefined;
    return row === undefined ? 0 : Number(row.value);
  }

  lookupDedup(deviceId: string, sampleAt: number, now: number): number | null {
    const row = this.db
      .prepare("SELECT receipt, first_accepted_at FROM dedup WHERE device_id = ? AND sample_at = ?")
      .get(deviceId, sampleAt) as { receipt: number; first_accepted_at: number } | undefined;
    if (row === undefined) {
      return null;
    }
    if (now - Number(row.first_accepted_at) >= DEDUP_WINDOW_MS) {
      this.db
        .prepare("DELETE FROM dedup WHERE device_id = ? AND sample_at = ?")
        .run(deviceId, sampleAt);
      return null;
    }
    return Number(row.receipt);
  }

  accept(event: { deviceId: string; sampleAt: number; payload: Uint8Array }, now: number): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare("INSERT INTO pending (device_id, sample_at, payload, accepted_at) VALUES (?, ?, ?, ?)")
        .run(event.deviceId, event.sampleAt, Buffer.from(event.payload), now);
      const receipt = Number(result.lastInsertRowid);
      this.db
        .prepare("INSERT INTO dedup (device_id, sample_at, receipt, first_accepted_at) VALUES (?, ?, ?, ?)")
        .run(event.deviceId, event.sampleAt, receipt, now);
      this.db.exec("COMMIT");
      return receipt;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  nextDueBatch(threshold: number, limit: number): PendingRow[] {
    const rows = this.db
      .prepare(
        "SELECT receipt, device_id, sample_at, payload FROM pending " +
          "WHERE sample_at <= ? ORDER BY sample_at ASC, receipt ASC LIMIT ?",
      )
      .all(threshold, limit) as unknown as Array<{
      receipt: number;
      device_id: string;
      sample_at: number;
      payload: Uint8Array;
    }>;
    return rows.map((row) => ({
      receipt: Number(row.receipt),
      deviceId: row.device_id,
      sampleAt: Number(row.sample_at),
      payload: Buffer.from(row.payload),
    }));
  }

  commitArchived(receipts: number[], committedSize: number): void {
    if (receipts.length === 0) {
      return;
    }
    const placeholders = receipts.map(() => "?").join(", ");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`DELETE FROM pending WHERE receipt IN (${placeholders})`)
        .run(...receipts);
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(COMMITTED_SIZE_KEY, String(committedSize));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  expireDedup(now: number): void {
    this.db
      .prepare("DELETE FROM dedup WHERE first_accepted_at <= ?")
      .run(now - DEDUP_WINDOW_MS);
  }
}
