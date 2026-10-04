/**
 * Injected monotonic millisecond clock with cancellable one-shot timers.
 * All time values are milliseconds on an arbitrary monotonic epoch.
 */
export interface Clock {
  /** Current monotonic time in milliseconds. Never goes backwards. */
  now(): number;
  /**
   * Schedule a one-shot callback after `delayMs` (>= 0) milliseconds.
   * Returns a cancellation function; cancelling an already-fired or
   * already-cancelled timer is a no-op.
   */
  setTimeout(callback: () => void, delayMs: number): () => void;
}
