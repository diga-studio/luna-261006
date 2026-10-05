import type {
  CancelSignal,
  Executor,
  ExecutorResult,
  RequestHandle,
  RequestOutcome,
  TargetConfig,
  TargetOccupancy,
} from "./types.js";

export interface AllocatorOptions {
  readonly executor: Executor;
  /** Per-attempt wait limit in ms. Defaults to 3000. */
  readonly attemptTimeoutMs?: number;
  /** Backoff before retry 1 and 2 in ms. Defaults to [200, 400]. */
  readonly retryDelaysMs?: readonly [number, number];
  /** Maximum attempts per request. Defaults to 3. */
  readonly maxAttempts?: number;
}

class Signal implements CancelSignal {
  private listeners: Array<() => void> = [];
  cancelled = false;

  onCancel(listener: () => void): void {
    if (this.cancelled) {
      listener();
    } else {
      this.listeners.push(listener);
    }
  }

  fire(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    const pending = this.listeners;
    this.listeners = [];
    for (const listener of pending) listener();
  }
}

interface Attempt {
  readonly targetId: string;
  readonly signal: Signal;
  timer: unknown;
  timedOut: boolean;
  settled: boolean;
}

/**
 * Allocates requests to a single backend pool. Configuration and runtime
 * state live entirely in this process.
 */
export class Allocator {
  readonly executor: Executor;
  readonly attemptTimeoutMs: number;
  readonly retryDelaysMs: readonly [number, number];
  readonly maxAttempts: number;
  /** Current configuration: id -> concurrency limit. */
  private limits = new Map<string, number>();
  /** Live attempts per target id, including ids removed from config. */
  private occupied = new Map<string, number>();

  constructor(options: AllocatorOptions) {
    this.executor = options.executor;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 3000;
    this.retryDelaysMs = options.retryDelaysMs ?? [200, 400];
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  /** Atomically replaces the whole target configuration. */
  setTargets(targets: readonly TargetConfig[]): void {
    const next = new Map<string, number>();
    for (const target of targets) {
      if (next.has(target.id)) {
        throw new Error(`duplicate target id: ${target.id}`);
      }
      if (!Number.isInteger(target.maxConcurrency) || target.maxConcurrency < 1) {
        throw new Error(`invalid maxConcurrency for target ${target.id}`);
      }
      next.set(target.id, target.maxConcurrency);
    }
    this.limits = next;
  }

  /** Submits a cancellable request. */
  submit(): RequestHandle {
    return new Request(this);
  }

  /** Current occupancy per target, including removed-but-occupied ones. */
  occupancy(): readonly TargetOccupancy[] {
    const ids = new Set<string>([...this.limits.keys(), ...this.occupied.keys()]);
    return [...ids].sort().map((id) => ({
      id,
      occupied: this.occupied.get(id) ?? 0,
      maxConcurrency: this.limits.get(id) ?? null,
    }));
  }

  pickTarget(tried: ReadonlySet<string>): string | null {
    let best: string | null = null;
    let bestOccupied = Infinity;
    for (const [id, limit] of this.limits) {
      if (tried.has(id)) continue;
      const used = this.occupied.get(id) ?? 0;
      if (used >= limit) continue;
      if (used < bestOccupied || (used === bestOccupied && best !== null && id < best)) {
        best = id;
        bestOccupied = used;
      }
    }
    return best;
  }

  occupy(id: string): void {
    this.occupied.set(id, (this.occupied.get(id) ?? 0) + 1);
  }

  release(id: string): void {
    const used = (this.occupied.get(id) ?? 0) - 1;
    if (used <= 0) this.occupied.delete(id);
    else this.occupied.set(id, used);
  }
}

class Request implements RequestHandle {
  readonly outcome: Promise<RequestOutcome>;
  private readonly allocator: Allocator;
  private readonly tried = new Set<string>();
  private readonly live = new Set<Attempt>();
  private attempts = 0;
  private retryTimer: unknown = null;
  private settled = false;
  private resolveOutcome!: (outcome: RequestOutcome) => void;

  constructor(allocator: Allocator) {
    this.allocator = allocator;
    this.outcome = new Promise<RequestOutcome>((resolve) => {
      this.resolveOutcome = resolve;
    });
    this.startAttempt();
  }

  cancel(): void {
    if (this.settled) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const attempt of this.live) attempt.signal.fire();
    this.finish({ status: "cancelled" });
  }

  private finish(outcome: RequestOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveOutcome(outcome);
  }

  private startAttempt(): void {
    if (this.settled) return;
    const targetId = this.allocator.pickTarget(this.tried);
    if (targetId === null) {
      this.finish({ status: "no-target" });
      return;
    }
    this.tried.add(targetId);
    this.attempts += 1;
    this.allocator.occupy(targetId);

    const attempt: Attempt = {
      targetId,
      signal: new Signal(),
      timer: null,
      timedOut: false,
      settled: false,
    };
    attempt.timer = setTimeout(() => this.onTimeout(attempt), this.allocator.attemptTimeoutMs);
    this.live.add(attempt);

    let result: Promise<ExecutorResult>;
    try {
      result = Promise.resolve(this.allocator.executor(targetId, attempt.signal));
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(
      (res) => this.onSettle(attempt, res),
      (error: unknown) => this.onSettle(attempt, { ok: false, error })
    );
  }

  private onTimeout(attempt: Attempt): void {
    if (attempt.settled || attempt.timedOut) return;
    attempt.timedOut = true;
    attempt.signal.fire();
    this.onAttemptFailed(undefined);
  }

  private onSettle(attempt: Attempt, result: ExecutorResult): void {
    if (attempt.settled) return;
    attempt.settled = true;
    this.live.delete(attempt);
    this.allocator.release(attempt.targetId);
    if (attempt.timedOut) return; // late result only frees the slot
    clearTimeout(attempt.timer);
    if (result.ok) {
      this.finish({ status: "success" });
    } else {
      this.onAttemptFailed(result.error);
    }
  }

  private onAttemptFailed(error: unknown): void {
    if (this.settled) return;
    if (this.attempts >= this.allocator.maxAttempts) {
      this.finish({ status: "failed", error });
      return;
    }
    const delay = this.allocator.retryDelaysMs[this.attempts - 1] ?? 0;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startAttempt();
    }, delay);
  }
}
