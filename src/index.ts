export { TelemetryBuffer } from "./buffer";
export { LateEventError, ArchiveCorruptionError, InvalidCursorError } from "./errors";
export {
  DEDUP_WINDOW_MS,
  ARCHIVE_DELAY_MS,
  MAX_PAYLOAD_BYTES,
} from "./types";
export type {
  TelemetryEvent,
  IngestResult,
  ArchivedRecord,
  ReadPage,
  AdvanceHooks,
  TelemetryBufferOptions,
} from "./types";
