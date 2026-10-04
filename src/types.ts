/** Public types for the SentinelVault in-place encryption library. */

/** A single file entry in a batch manifest. Paths must be absolute. */
export interface FileEntry {
  /** Absolute path of a regular file. No symlinks / hardlinks. */
  path: string;
}

/** Options shared by every call that touches a batch. */
export interface VaultOptions {
  /** Directory that holds the SQLite task database (created if missing). */
  stateDir: string;
  /**
   * Test hook: invoked at deterministic crash points while processing.
   * Throwing (or killing the process) here simulates an abrupt termination.
   */
  crashHook?: (point: CrashPoint, filePath: string) => void;
}

/** Deterministic points where a crash is simulated in tests. */
export type CrashPoint =
  | "temp-write-started"
  | "temp-write-chunk"
  | "temp-write-finished"
  | "after-rename"
  | "after-record";

/** Per-file progress as reconciled with on-disk state. */
export interface FileProgress {
  path: string;
  done: boolean;
}

/** Progress of a batch. `complete === true` means every file is final ciphertext. */
export interface BatchProgress {
  batchId: string;
  total: number;
  completed: number;
  complete: boolean;
  files: FileProgress[];
}
