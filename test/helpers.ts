import { Clock } from '../src/clock';

/** Deterministic monotonic clock with one-shot timers for tests. */
export class VirtualClock implements Clock {
  private current = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; cb: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): () => void {
    const id = this.nextId++;
    const at = this.current + Math.max(0, delayMs);
    this.timers.set(id, { at, cb: callback });
    return () => {
      this.timers.delete(id);
    };
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  /** Deadline of the earliest pending timer, or null when none is armed. */
  nextDeadline(): number | null {
    let best = Infinity;
    for (const timer of this.timers.values()) {
      if (timer.at < best) best = timer.at;
    }
    return best === Infinity ? null : best;
  }

  advanceBy(ms: number): void {
    this.advanceTo(this.current + ms);
  }

  advanceTo(target: number): void {
    for (;;) {
      let bestId = -1;
      let bestAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (timer.at < bestAt || (timer.at === bestAt && id < bestId))) {
          bestAt = timer.at;
          bestId = id;
        }
      }
      if (bestId === -1) break;
      const timer = this.timers.get(bestId)!;
      this.timers.delete(bestId);
      this.current = timer.at;
      timer.cb();
    }
    this.current = target;
  }
}

/** Drain all pending microtasks (promise continuations). */
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export interface WriteEvent {
  stream: string;
  time: number;
  bytes: number;
}

/** Records every write call with the virtual time it happened at. */
export class WriteRecorder {
  readonly events: WriteEvent[] = [];

  constructor(private readonly clock: VirtualClock) {}

  writer(stream: string): (chunk: Uint8Array) => Promise<void> {
    return async (chunk: Uint8Array) => {
      this.events.push({ stream, time: this.clock.now(), bytes: chunk.length });
    };
  }

  bytesIn(streams: string[] | null, t1: number, t2: number): number {
    let total = 0;
    for (const event of this.events) {
      if (streams !== null && !streams.includes(event.stream)) continue;
      if (event.time > t1 && event.time <= t2) total += event.bytes;
    }
    return total;
  }

  cumulative(stream: string, t: number): number {
    let total = 0;
    for (const event of this.events) {
      if (event.stream === stream && event.time <= t) total += event.bytes;
    }
    return total;
  }

  distinctTimes(): number[] {
    return [...new Set(this.events.map((event) => event.time))].sort((a, b) => a - b);
  }

  /**
   * Prefix sums of bytes per distinct event time, optionally restricted to
   * one stream. `prefix[i]` = bytes of matching events at times[0..i].
   */
  prefixSums(stream: string | null = null): { times: number[]; prefix: number[] } {
    const times = this.distinctTimes();
    const index = new Map<number, number>();
    times.forEach((time, i) => index.set(time, i));
    const prefix = new Array<number>(times.length).fill(0);
    for (const event of this.events) {
      if (stream !== null && event.stream !== stream) continue;
      prefix[index.get(event.time)!]! += event.bytes;
    }
    for (let i = 1; i < prefix.length; i++) prefix[i]! += prefix[i - 1]!;
    return { times, prefix };
  }
}

export interface ControlledSourceOptions {
  /** Chunk sizes to yield; repeats the last size forever when `forever`. */
  sizes: number[];
  forever?: boolean;
  /** If set, the next() call with this 0-based index never resolves. */
  hangNextAt?: number;
  /** Reject the next() call with this 0-based index. */
  failNextAt?: number;
}

/**
 * Async source with instrumentation: counts next() calls, tracks that the
 * shaper never pulls a new chunk before the previous one is fully written,
 * and never has more than one next() in flight.
 */
export class ControlledSource implements AsyncIterable<Uint8Array> {
  nextCalls = 0;
  outstandingNext = 0;
  maxOutstandingNext = 0;
  yieldedBytes = 0;
  /** Set by the test to release a hanging next(). */
  releaseHang: (() => void) | null = null;
  private readonly failures: Error[] = [];

  constructor(
    private readonly name: string,
    private readonly options: ControlledSourceOptions,
    private readonly writtenBytes: () => number,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    const self = this;
    let index = 0;
    return {
      next(): Promise<IteratorResult<Uint8Array>> {
        self.nextCalls += 1;
        self.outstandingNext += 1;
        self.maxOutstandingNext = Math.max(self.maxOutstandingNext, self.outstandingNext);
        // The previously yielded bytes must all be written by now:
        // at most one unsent input chunk may exist per transfer.
        if (self.writtenBytes() !== self.yieldedBytes) {
          self.failures.push(
            new Error(
              `${self.name}: next() #${index} called with ${self.yieldedBytes - self.writtenBytes()} unsent bytes`,
            ),
          );
        }
        const finish = (result: IteratorResult<Uint8Array>): IteratorResult<Uint8Array> => {
          self.outstandingNext -= 1;
          return result;
        };
        const current = index;
        index += 1;
        if (current === self.options.hangNextAt) {
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            self.releaseHang = () => resolve(finish({ done: true, value: undefined }));
          });
        }
        if (current === self.options.failNextAt) {
          return Promise.reject(new Error(`${self.name}: source failure`)).finally(() => {
            self.outstandingNext -= 1;
          }) as Promise<IteratorResult<Uint8Array>>;
        }
        const sizes = self.options.sizes;
        const size = sizes[Math.min(current, sizes.length - 1)]!;
        if (current >= sizes.length && !self.options.forever) {
          return Promise.resolve(finish({ done: true, value: undefined }));
        }
        const chunk = new Uint8Array(size).fill(1);
        self.yieldedBytes += size;
        return Promise.resolve(finish({ done: false, value: chunk }));
      },
    };
  }

  assertNoProtocolViolations(): void {
    if (this.failures.length > 0) {
      throw this.failures[0];
    }
  }
}
