import * as fs from "node:fs";
import * as path from "node:path";
import { Archive } from "./archive.ts";
import { Store } from "./store.ts";
import {
  DEDUP_WINDOW_MS,
  LATE_THRESHOLD_MS,
  MAX_PAYLOAD_BYTES,
  MAX_RESIDENT_RECORDS,
} from "./types.ts";
import type {
  CrashHooks,
  IngestResult,
  ReadPage,
  TelemetryBufferOptions,
  TelemetryEvent,
} from "./types.ts";

export class TelemetryBuffer {
  private store: Store;
  private archive: Archive;
  private batchSize: number;
  private crashHooks: CrashHooks | undefined;

  constructor(options: TelemetryBufferOptions) {
    fs.mkdirSync(options.dir, { recursive: true });
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? 128, MAX_RESIDENT_RECORDS));
    this.crashHooks = options.crashHooks;
    this.store = new Store(path.join(options.dir, "state.db"));
    this.archive = new Archive(path.join(options.dir, "archive.bin"));
    const replay = this.archive.recover(this.store.committedOffset);
    if (replay.records.length > 0) {
      this.store.markArchived(
        replay.records.map((record) => record.receipt),
        replay.goodOffset,
      );
    }
  }

  ingest(event: TelemetryEvent, now: number): IngestResult {
    if (event.payload.byteLength > MAX_PAYLOAD_BYTES) {
      throw new Error(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    this.store.gcDedup(now);
    const existing = this.store.findDedup(event.deviceId, event.sampleAt);
    if (existing !== null && now < existing.acceptedAt + DEDUP_WINDOW_MS) {
      return { status: "duplicate", receipt: existing.receipt };
    }
    if (event.sampleAt <= now - LATE_THRESHOLD_MS) {
      return { status: "rejected", reason: "late" };
    }
    const receipt = this.store.accept(event, now);
    return { status: "accepted", receipt };
  }

  advance(now: number): number {
    const threshold = now - LATE_THRESHOLD_MS;
    let archived = 0;
    for (;;) {
      const batch = this.store.pendingBatch(threshold, this.batchSize);
      if (batch.length === 0) break;
      const endOffset = this.archive.appendBatch(batch, {
        beforeRecordWrite: this.crashHooks?.beforeRecordWrite,
        afterRecordWrite: this.crashHooks?.afterRecordWrite,
      });
      this.archive.fsync();
      this.crashHooks?.afterFsync?.(batch.length);
      this.crashHooks?.beforeStateCommit?.(batch.length);
      this.store.markArchived(
        batch.map((record) => record.receipt),
        endOffset,
      );
      this.archive.markCommitted(endOffset);
      archived += batch.length;
    }
    return archived;
  }

  read(cursor: string | null, limit: number): ReadPage {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("limit must be a positive integer");
    }
    return this.archive.readFrom(cursor, limit);
  }

  close(): void {
    this.store.close();
    this.archive.close();
  }
}
