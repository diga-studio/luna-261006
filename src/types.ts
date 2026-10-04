export const DEDUP_WINDOW_MS = 30_000;
export const LATE_THRESHOLD_MS = 60_000;
export const MAX_PAYLOAD_BYTES = 4096;
export const MAX_RESIDENT_RECORDS = 256;

export interface TelemetryEvent {
  deviceId: string;
  sampleAt: number;
  payload: Uint8Array;
}

export type IngestResult =
  | { status: "accepted"; receipt: number }
  | { status: "duplicate"; receipt: number }
  | { status: "rejected"; reason: "late" };

export interface ArchivedRecord {
  receipt: number;
  deviceId: string;
  sampleAt: number;
  payload: Uint8Array;
}

export interface ReadPage {
  records: ArchivedRecord[];
  nextCursor: string | null;
}

export interface CrashHooks {
  beforeRecordWrite?: (indexInBatch: number, record: ArchivedRecord) => void;
  afterRecordWrite?: (indexInBatch: number, record: ArchivedRecord) => void;
  afterFsync?: (batchCount: number) => void;
  beforeStateCommit?: (batchCount: number) => void;
}

export interface TelemetryBufferOptions {
  dir: string;
  batchSize?: number;
  crashHooks?: CrashHooks;
}
