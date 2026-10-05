import { Key } from "../../src/types";

/**
 * Deterministic pause point for the recompute loop. The test arms the gate
 * with pauseAfter(n); once the n-th student has been processed the hook
 * resolves the returned "paused" promise and blocks until resume() is called.
 * No sleeps involved: every transition is an explicit promise hand-off.
 */
export class RecomputeGate {
  private pauseAt: number | null = null;
  private notifyPaused: ((processed: number) => void) | null = null;
  private release: (() => void) | null = null;

  pauseAfter(processed: number): Promise<number> {
    this.pauseAt = processed;
    return new Promise<number>((resolve) => {
      this.notifyPaused = resolve;
    });
  }

  resume(): void {
    this.pauseAt = null;
    const release = this.release;
    this.release = null;
    this.notifyPaused = null;
    if (release) release();
  }

  hook = async (_key: Key, _studentId: string, processed: number): Promise<void> => {
    if (this.pauseAt === null || processed < this.pauseAt) return;
    const notify = this.notifyPaused;
    this.pauseAt = null;
    this.notifyPaused = null;
    if (notify) notify(processed);
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  };
}
