import type { Clock, CancelTimer } from "../src/clock.js";

interface TimerEntry {
  id: number;
  at: number;
  cb: () => void;
  cancelled: boolean;
}

function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Deterministic test clock: time only moves via `advance`/`jump`. */
export class VirtualClock implements Clock {
  private time = 0;
  private seq = 0;
  private timers: TimerEntry[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): CancelTimer {
    const entry: TimerEntry = {
      id: ++this.seq,
      at: this.time + Math.max(0, delayMs),
      cb: callback,
      cancelled: false,
    };
    this.timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  /** Number of pending (not yet fired, not cancelled) one-shot timers. */
  get pendingTimers(): number {
    this.timers = this.timers.filter((t) => !t.cancelled);
    return this.timers.length;
  }

  /** Instantly moves the clock forward without firing timers in between. */
  jump(ms: number): void {
    this.time += ms;
  }

  /** Flushes pending microtasks without moving time. */
  async flush(): Promise<void> {
    await flushMicrotasks();
  }

  /** Advances time, firing due timers in order and flushing microtasks. */
  async advance(ms: number): Promise<void> {
    // Let pending microtasks (e.g. freshly scheduled timers) settle first.
    await flushMicrotasks();
    const target = this.time + ms;
    for (;;) {
      let next: TimerEntry | undefined;
      for (const t of this.timers) {
        if (t.cancelled || t.at > target) continue;
        if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) {
          next = t;
        }
      }
      if (!next) break;
      // A jumped clock stays at the jumped-to time; timers observe it.
      this.time = Math.max(this.time, next.at);
      next.cancelled = true;
      next.cb();
      await flushMicrotasks();
    }
    this.time = target;
    await flushMicrotasks();
  }
}
