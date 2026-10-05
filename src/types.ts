/** Task / batch priority: 1 (highest) .. 5 (lowest). */
export type Priority = 1 | 2 | 3 | 4 | 5;

/** Fixed lease duration for every claim, in milliseconds. */
export const LEASE_MS = 60_000;

/** One camera task inside a batch submission. */
export interface CameraTaskInput {
  /** Caller-side camera identifier, unique within the batch. */
  cameraId: string;
}

/** Batch submission payload. */
export interface BatchInput {
  /** Stable caller-provided batch identifier (idempotency key). */
  batchId: string;
  /** Unified priority for every camera task in the batch. */
  priority: Priority;
  /** Camera tasks; their array order is the in-batch camera order. */
  cameras: CameraTaskInput[];
}

/** Summary of an enqueued (or idempotently re-enqueued) batch. */
export interface EnqueuedBatch {
  batchId: string;
  priority: Priority;
  taskIds: number[];
  /** True when the batch already existed and nothing new was created. */
  alreadyExisted: boolean;
}

export type TaskStatus = "pending" | "leased" | "succeeded";

/** A claimed task: one distinguishable execution attempt. */
export interface ClaimedTask {
  /** Unique, distinguishable attempt identifier. */
  attemptId: number;
  taskId: number;
  batchId: string;
  cameraId: string;
  priority: Priority;
  leasedAt: number;
  expiresAt: number;
}

export type SubmitResult =
  | { ok: true; taskId: number; attemptId: number; artifactPath: string }
  | {
      ok: false;
      reason:
        | "unknown-attempt"
        | "superseded"
        | "lease-expired"
        | "artifact-missing"
        | "conflicting-bytes";
    };

export interface TaskView {
  taskId: number;
  cameraId: string;
  status: TaskStatus;
  /** Absolute path of the stored artifact, once the task has succeeded. */
  artifactPath: string | null;
  /** Artifact bytes, once the task has succeeded. */
  artifactBytes: Buffer | null;
}

export interface BatchView {
  batchId: string;
  priority: Priority;
  /** True only when every camera task has succeeded. */
  complete: boolean;
  tasks: TaskView[];
}

export interface RenderQueueOptions {
  /** Directory holding queue.db and the artifacts/ folder. */
  dataDir: string;
  /** Business clock supplied by the caller; never moves backwards. */
  now: () => number;
}
