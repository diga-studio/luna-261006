/** Optional knobs, mainly for testing and tuning. */
export interface EngineOptions {
  /**
   * Called between scan batches during a rebuild. Awaiting it lets callers
   * (e.g. tests) control interleaving of rebuilds with other operations.
   * Defaults to yielding to the event loop.
   */
  onScanBatch?: (generation: number) => void | Promise<void>;
}
