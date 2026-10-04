import * as fs from "node:fs";
import * as path from "node:path";
import { ArchiveFile } from "./archive";
import { InvalidCursorError, LateEventError } from "./errors";
import { StateStore } from "./state";
import type {
  AdvanceHooks,
  IngestResult,
  ReadPage,
  TelemetryBufferOptions,
  TelemetryEvent,
} from "./types";
import { ARCHIVE_DELAY_MS, MAX_PAYLOAD_BYTES } from "./types";

const ADVANCE_BATCH_SIZE = 128;
const STATE_FILE = "state.sqlite";
const ARCHIVE_FILE = "archive.log";

export class TelemetryBuffer {
  private readonly state: StateStore;
  private readonly archive: ArchiveFile;
  private readonly hooks: AdvanceHooks | undefined;
  private closed = false;

  constructor(options: TelemetryBufferOptions) {
    fs.mkdirSync(options.dir, { recursive: true });
    this.state = new StateStore(path.join(options.dir, STATE_FILE));
    try {
      this.archive = new ArchiveFile(
        path.join(options.dir, ARCHIVE_FILE),
        this.state.getCommittedSize(),
      );
    } catch (err) {
      this.state.close();
      throw err;
    }
    this.hooks = options.hooks;
  }

  ingest(event: TelemetryEvent, now: number): IngestResult {
    this.assertOpen();
    validateEvent(event, now);
    const existing = this.state.lookupDedup(event.deviceId, event.sampleAt, now);
    if (existing !== null) {
      return { receipt: existing, duplicate: true };
    }
    if (event.sampleAt <= now - ARCHIVE_DELAY_MS) {
      throw new LateEventError(
        `sampleAt ${event.sampleAt} is older than now - ${ARCHIVE_DELAY_MS} (now = ${now})`,
      );
    }
    const receipt = this.state.accept(event, now);
    return { receipt, duplicate: false };
  }

  advance(now: number): void {
    this.assertOpen();
    const threshold = now - ARCHIVE_DELAY_MS;
    for (;;) {
      const batch = this.state.nextDueBatch(threshold, ADVANCE_BATCH_SIZE);
      if (batch.length === 0) {
        break;
      }
      const committedSize = this.archive.appendBatch(batch, this.hooks);
      this.state.commitArchived(
        batch.map((row) => row.receipt),
        committedSize,
      );
    }
    this.state.expireDedup(now);
  }

  read(cursor: string | undefined, limit: number): ReadPage {
    this.assertOpen();
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(`limit must be a positive integer, got ${limit}`);
    }
    const offset = parseCursor(cursor);
    const committedSize = this.state.getCommittedSize();
    if (offset > committedSize) {
      throw new InvalidCursorError(
        `cursor offset ${offset} is beyond committed size ${committedSize}`,
      );
    }
    const { records, nextOffset } = this.archive.readFrom(offset, limit, committedSize);
    return { records, nextCursor: String(nextOffset) };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.archive.close();
    this.state.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("TelemetryBuffer is closed");
    }
  }
}

function validateEvent(event: TelemetryEvent, now: number): void {
  if (!Number.isInteger(now) || now < 0) {
    throw new RangeError(`now must be a non-negative integer, got ${now}`);
  }
  if (typeof event.deviceId !== "string" || event.deviceId.length === 0) {
    throw new RangeError("deviceId must be a non-empty string");
  }
  if (!Number.isInteger(event.sampleAt) || event.sampleAt < 0) {
    throw new RangeError(`sampleAt must be a non-negative integer, got ${event.sampleAt}`);
  }
  if (event.sampleAt > now) {
    throw new RangeError(`sampleAt ${event.sampleAt} is in the future (now = ${now})`);
  }
  if (event.payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw new RangeError(
      `payload is ${event.payload.byteLength} bytes, max is ${MAX_PAYLOAD_BYTES}`,
    );
  }
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") {
    return 0;
  }
  if (!/^\d+$/.test(cursor)) {
    throw new InvalidCursorError(`malformed cursor: ${JSON.stringify(cursor)}`);
  }
  return Number(cursor);
}
