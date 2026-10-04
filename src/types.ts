export interface TelemetryEvent {
  deviceId: string;
  sampleAt: number;
  payload: Uint8Array;
}

export interface IngestResult {
  receipt: number;
  duplicate: boolean;
}

export interface ArchivedRecord {
  receipt: number;
  deviceId: string;
  sampleAt: number;
  payload: Buffer;
}

export interface ReadPage {
  records: ArchivedRecord[];
  nextCursor: string;
}

export interface AdvanceHooks {
  onPartialWrite?: () => void;
  afterFsyncBeforeCommit?: () => void;
}

export interface TelemetryBufferOptions {
  dir: string;
  hooks?: AdvanceHooks;
}

export const DEDUP_WINDOW_MS = 30_000;
export const ARCHIVE_DELAY_MS = 60_000;
export const MAX_PAYLOAD_BYTES = 4096;
