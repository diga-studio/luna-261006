/** Cancels a pending one-shot timer. */
export type CancelTimer = () => void;

/** Monotonic millisecond clock with cancellable one-shot timers. */
export interface Clock {
  /** Current monotonic time in milliseconds. */
  now(): number;
  /** Schedules a one-shot callback after `delayMs`; returns a cancel function. */
  setTimeout(callback: () => void, delayMs: number): CancelTimer;
}

/** Clock backed by `Date.now()` and real timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};
