/** A backend target with a stable, unique id and a concurrency limit. */
export interface TargetConfig {
  readonly id: string;
  /** Maximum number of concurrent attempts occupying this target. */
  readonly maxConcurrency: number;
}

/** Signals an attempt that it should stop. The executor may ignore it. */
export interface CancelSignal {
  readonly cancelled: boolean;
  onCancel(listener: () => void): void;
}

/**
 * In-process async executor provided by the caller. It receives the target
 * id and a cancel signal, and resolves with success or failure. It may
 * respond late or ignore cancellation entirely.
 */
export type Executor = (
  targetId: string,
  signal: CancelSignal
) => Promise<ExecutorResult>;

export type ExecutorResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error?: unknown };

/** Final outcome of a submitted request. Exactly one is produced. */
export type RequestOutcome =
  | { readonly status: "success" }
  | { readonly status: "failed"; readonly error?: unknown }
  | { readonly status: "no-target" }
  | { readonly status: "cancelled" };

/** Handle returned to the caller for a submitted request. */
export interface RequestHandle {
  /** Resolves exactly once with the final outcome. */
  readonly outcome: Promise<RequestOutcome>;
  /** Cancels the request: stops waiting, signals all live attempts. */
  cancel(): void;
}

/** Occupancy snapshot for a single target. */
export interface TargetOccupancy {
  readonly id: string;
  /** Currently occupied slots (live attempts), including removed targets. */
  readonly occupied: number;
  /** Concurrency limit; absent when the target was removed from config. */
  readonly maxConcurrency: number | null;
}
