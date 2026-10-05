import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Allocator } from "../dist/index.js";
import type { CancelSignal, ExecutorResult } from "../dist/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Call {
  targetId: string;
  signal: CancelSignal;
  resolve: (r: ExecutorResult) => void;
}

/** Executor whose calls are captured and settled manually. */
function manualExecutor(defaultResult?: ExecutorResult) {
  const calls: Call[] = [];
  const executor = (targetId: string, signal: CancelSignal) =>
    new Promise<ExecutorResult>((resolve) => {
      calls.push({ targetId, signal, resolve });
      if (defaultResult !== undefined) resolve(defaultResult);
    });
  return { calls, executor };
}

describe("Allocator", () => {
  it("picks the least-occupied target, breaking ties by id", async () => {
    const { calls, executor } = manualExecutor();
    const a = new Allocator({ executor });
    a.setTargets([
      { id: "b", maxConcurrency: 2 },
      { id: "a", maxConcurrency: 2 },
    ]);
    a.submit();
    a.submit();
    a.submit();
    await sleep(10);
    assert.deepEqual(calls.map((c) => c.targetId), ["a", "b", "a"]);
  });

  it("ends with no-target immediately when nothing has room", async () => {
    const { calls, executor } = manualExecutor();
    const a = new Allocator({ executor });
    a.setTargets([{ id: "a", maxConcurrency: 1 }]);
    const first = a.submit();
    await sleep(10);
    const second = a.submit();
    assert.deepEqual(await second.outcome, { status: "no-target" });
    assert.equal(calls.length, 1);
    calls[0].resolve({ ok: true });
    assert.deepEqual(await first.outcome, { status: "success" });
  });

  it("fails after 3 attempts when the executor keeps failing", async () => {
    const { calls, executor } = manualExecutor({ ok: false });
    const a = new Allocator({
      executor,
      attemptTimeoutMs: 50,
      retryDelaysMs: [5, 5],
    });
    a.setTargets([
      { id: "a", maxConcurrency: 1 },
      { id: "b", maxConcurrency: 1 },
      { id: "c", maxConcurrency: 1 },
    ]);
    const outcome = await a.submit().outcome;
    assert.equal(outcome.status, "failed");
    assert.equal(calls.length, 3);
    assert.deepEqual(
      a.occupancy().map((o) => o.occupied),
      [0, 0, 0]
    );
  });

  it("never retries a target id already tried by the same request", async () => {
    const { calls, executor } = manualExecutor({ ok: false });
    const a = new Allocator({
      executor,
      attemptTimeoutMs: 50,
      retryDelaysMs: [5, 5],
    });
    a.setTargets([{ id: "a", maxConcurrency: 5 }]);
    const outcome = await a.submit().outcome;
    // The only target was already tried, so the retry finds nothing.
    assert.equal(outcome.status, "no-target");
    assert.equal(calls.length, 1);
  });

  it("cancel signals live attempts and ends the wait", async () => {
    const { calls, executor } = manualExecutor();
    const a = new Allocator({ executor, attemptTimeoutMs: 1000 });
    a.setTargets([{ id: "a", maxConcurrency: 1 }]);
    const handle = a.submit();
    await sleep(10);
    handle.cancel();
    assert.deepEqual(await handle.outcome, { status: "cancelled" });
    assert.equal(calls[0].signal.cancelled, true);
    // Slot is still occupied until the executor actually finishes.
    assert.equal(a.occupancy()[0].occupied, 1);
    calls[0].resolve({ ok: true });
    await sleep(10);
    assert.equal(a.occupancy()[0].occupied, 0);
  });

  it("cancel during the retry wait prevents further attempts", async () => {
    const { calls, executor } = manualExecutor();
    const a = new Allocator({
      executor,
      attemptTimeoutMs: 50,
      retryDelaysMs: [80, 80],
    });
    a.setTargets([{ id: "a", maxConcurrency: 2 }]);
    const handle = a.submit();
    await sleep(10);
    assert.equal(calls.length, 1);
    calls[0].resolve({ ok: false }); // first attempt fails -> retry wait
    await sleep(20);
    handle.cancel(); // cancel while waiting for the retry delay
    assert.deepEqual(await handle.outcome, { status: "cancelled" });
    await sleep(150); // well past the retry delay
    assert.equal(calls.length, 1); // no retry ever started
  });

  it("keeps exactly one outcome when a timed-out attempt succeeds late", async () => {
    const { calls, executor } = manualExecutor();
    const a = new Allocator({
      executor,
      attemptTimeoutMs: 30,
      retryDelaysMs: [10, 10],
    });
    a.setTargets([
      { id: "a", maxConcurrency: 1 },
      { id: "b", maxConcurrency: 1 },
    ]);
    const handle = a.submit();
    let outcomes = 0;
    let last: unknown;
    void handle.outcome.then((o) => {
      outcomes += 1;
      last = o;
    });
    // Attempt on "a" times out; retry goes to "b" and succeeds.
    await sleep(60);
    assert.equal(calls.length, 2);
    calls[1].resolve({ ok: true });
    await sleep(10);
    assert.deepEqual(last, { status: "success" });
    // The old attempt on "a" reports success only now: no effect.
    calls[0].resolve({ ok: true });
    await sleep(50);
    assert.equal(outcomes, 1);
    assert.deepEqual(last, { status: "success" });
    assert.deepEqual(
      a.occupancy().map((o) => o.occupied),
      [0, 0]
    );
  });

  it("counts a removed-then-readded target's old occupancy until it ends", async () => {
    const { calls, executor } = manualExecutor();
    const a = new Allocator({
      executor,
      attemptTimeoutMs: 30,
      retryDelaysMs: [10, 10],
    });
    a.setTargets([{ id: "a", maxConcurrency: 1 }]);
    const first = a.submit();
    await sleep(10);
    assert.equal(calls.length, 1);
    // Attempt times out but the executor never finishes: slot stays occupied.
    const firstOutcome = await first.outcome; // retries find no target
    assert.equal(firstOutcome.status, "no-target");
    assert.equal(a.occupancy()[0].occupied, 1);

    // Remove the target: occupancy must still be reported.
    a.setTargets([]);
    assert.deepEqual(a.occupancy(), [
      { id: "a", occupied: 1, maxConcurrency: null },
    ]);

    // Re-add the same id: the old attempt still counts against the limit.
    a.setTargets([{ id: "a", maxConcurrency: 1 }]);
    const blocked = a.submit();
    assert.deepEqual(await blocked.outcome, { status: "no-target" });
    assert.equal(calls.length, 1);

    // Only when the old attempt truly ends can a new one be allocated.
    calls[0].resolve({ ok: false });
    await sleep(10);
    assert.equal(a.occupancy()[0].occupied, 0);
    const third = a.submit();
    await sleep(10);
    assert.equal(calls.length, 2);
    calls[1].resolve({ ok: true });
    assert.deepEqual(await third.outcome, { status: "success" });
  });

  it("applies a lowered limit only to new allocations", async () => {
    const { calls, executor } = manualExecutor();
    const a = new Allocator({ executor, attemptTimeoutMs: 1000 });
    a.setTargets([{ id: "a", maxConcurrency: 2 }]);
    a.submit();
    a.submit();
    await sleep(10);
    assert.equal(calls.length, 2);
    a.setTargets([{ id: "a", maxConcurrency: 1 }]); // lower below occupancy
    const blocked = a.submit();
    assert.deepEqual(await blocked.outcome, { status: "no-target" });
    calls[0].resolve({ ok: true }); // occupancy drops to 1, still at limit
    await sleep(10);
    const stillBlocked = a.submit();
    assert.deepEqual(await stillBlocked.outcome, { status: "no-target" });
    calls[1].resolve({ ok: true }); // occupancy drops to 0
    await sleep(10);
    const ok = a.submit();
    await sleep(10);
    assert.equal(calls.length, 3);
    calls[2].resolve({ ok: true });
    assert.deepEqual(await ok.outcome, { status: "success" });
  });
});
