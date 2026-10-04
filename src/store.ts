import { DatabaseSync } from "node:sqlite";
import { DEDUP_WINDOW_MS } from "./types.ts";
import type { ArchivedRecord, TelemetryEvent } from "./types.ts";

export interface DedupEntry {
  receipt: number;
  acceptedAt: number;
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dedup (
        device_id TEXT NOT NULL,
        sample_at INTEGER NOT NULL,
        receipt INTEGER NOT NULL,
        accepted_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, sample_at)
      );
      CREATE TABLE IF NOT EXISTS pending (
        receipt INTEGER PRIMARY KEY,
        device_id TEXT NOT NULL,
        sample_at INTEGER NOT NULL,
        payload BLOB NOT NULL,
        accepted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_by_sample ON pending (sample_at, receipt);
    `);
    this.db.exec(
      "INSERT OR IGNORE INTO meta (key, value) VALUES ('committed_offset', 0), ('next_receipt', 1)",
    );
  }

  private metaGet(key: string): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: number }
      | undefined;
    if (row === undefined) throw new Error(`missing meta key: ${key}`);
    return Number(row.value);
  }

  private metaSet(key: string, value: number): void {
    this.db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(value, key);
  }

  get committedOffset(): number {
    return this.metaGet("committed_offset");
  }

  findDedup(deviceId: string, sampleAt: number): DedupEntry | null {
    const row = this.db
      .prepare("SELECT receipt, accepted_at AS acceptedAt FROM dedup WHERE device_id = ? AND sample_at = ?")
      .get(deviceId, sampleAt) as DedupEntry | undefined;
    return row === undefined ? null : { receipt: Number(row.receipt), acceptedAt: Number(row.acceptedAt) };
  }

  gcDedup(now: number): void {
    this.db.prepare("DELETE FROM dedup WHERE accepted_at + ? <= ?").run(DEDUP_WINDOW_MS, now);
  }

  accept(event: TelemetryEvent, acceptedAt: number): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.metaGet("next_receipt");
      this.metaSet("next_receipt", receipt + 1);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO dedup (device_id, sample_at, receipt, accepted_at) VALUES (?, ?, ?, ?)",
        )
        .run(event.deviceId, event.sampleAt, receipt, acceptedAt);
      this.db
        .prepare(
          "INSERT INTO pending (receipt, device_id, sample_at, payload, accepted_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(receipt, event.deviceId, event.sampleAt, event.payload, acceptedAt);
      this.db.exec("COMMIT");
      return receipt;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  pendingBatch(threshold: number, limit: number): ArchivedRecord[] {
    const rows = this.db
      .prepare(
        "SELECT receipt, device_id AS deviceId, sample_at AS sampleAt, payload FROM pending WHERE sample_at <= ? ORDER BY sample_at, receipt LIMIT ?",
      )
      .all(threshold, limit) as unknown as Array<{
      receipt: number;
      deviceId: string;
      sampleAt: number;
      payload: Uint8Array;
    }>;
    return rows.map((row) => ({
      receipt: Number(row.receipt),
      deviceId: row.deviceId,
      sampleAt: Number(row.sampleAt),
      payload: row.payload,
    }));
  }

  markArchived(receipts: number[], committedOffset: number): void {
    if (receipts.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const del = this.db.prepare("DELETE FROM pending WHERE receipt = ?");
      for (const receipt of receipts) {
        del.run(receipt);
      }
      this.metaSet("committed_offset", committedOffset);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
