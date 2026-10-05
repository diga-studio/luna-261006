/** Priority levels: 1 is highest, 5 is lowest. */
export type Priority = 1 | 2 | 3 | 4 | 5;

export interface EnqueueBatchInput {
  /** Stable caller-provided batch identifier. */
  batchId: string;
  priority: Priority;
  /** Camera names in batch-local order. */
  cameras: string[];
}

export interface EnqueueBatchResult {
  batchId: string;
  /** false when the call was an idempotent retry of an existing batch. */
  created: boolean;
  taskCount: number;
}

export interface ClaimedTask {
  taskId: number;
  attemptId: string;
  batchId: string;
  camera: string;
  priority: Priority;
  leasedAt: number;
  leaseExpiresAt: number;
}

export type SubmitStatus = 'accepted' | 'duplicate' | 'rejected';

export type SubmitRejectReason =
  | 'unknown-attempt'
  | 'stale-attempt'
  | 'lease-expired'
  | 'byte-mismatch';

export interface SubmitResult {
  status: SubmitStatus;
  reason?: SubmitRejectReason;
  taskId?: number;
}

export type TaskStatus = 'pending' | 'leased' | 'completed';

export interface TaskResultHandle {
  /** Path of the persisted result file inside the queue's results directory. */
  path: string;
  /** Reads the persisted result bytes back. */
  read(): Buffer;
}

export interface TaskView {
  taskId: number;
  camera: string;
  status: TaskStatus;
  result?: TaskResultHandle;
}

export interface BatchView {
  batchId: string;
  priority: Priority;
  /** True only when every camera task of the batch has completed. */
  complete: boolean;
  tasks: TaskView[];
}

export interface RenderQueueOptions {
  /** Directory holding the SQLite database file and the results directory. */
  dir: string;
}
