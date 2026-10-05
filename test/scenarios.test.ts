import { deepEqual, equal, ok } from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { LEASE_MS } from "../src/index";
import { makeContext } from "./helpers";

test("stale attempt cannot overwrite a succeeded newer attempt", () => {
  const ctx = makeContext();
  try {
    ctx.queue.enqueueBatch({
      batchId: "batch-1",
      priority: 3,
      cameras: [{ cameraId: "cam-a" }],
    });

    const first = ctx.queue.claim();
    ok(first !== null);
    equal(first.cameraId, "cam-a");

    // Worker 1 disappears; lease expires; worker 2 picks the task up.
    ctx.clock.advance(LEASE_MS);
    const second = ctx.queue.claim();
    ok(second !== null);
    equal(second.taskId, first.taskId);
    ok(second.attemptId !== first.attemptId);

    const newSource = ctx.writeSource("new.bin", [1, 2, 3]);
    const accepted = ctx.queue.submitResult(second.attemptId, newSource);
    ok(accepted.ok);

    // The old worker comes back and submits its own (different) result.
    const oldSource = ctx.writeSource("old.bin", [9, 9, 9]);
    const stale = ctx.queue.submitResult(first.attemptId, oldSource);
    deepEqual(stale, { ok: false, reason: "superseded" });

    // Only the new attempt's bytes are readable; the old submit changed nothing.
    const view = ctx.queue.getBatch("batch-1");
    ok(view !== null);
    equal(view.complete, true);
    equal(view.tasks.length, 1);
    equal(view.tasks[0].status, "succeeded");
    deepEqual(Array.from(view.tasks[0].artifactBytes as Buffer), [1, 2, 3]);
    ok(view.tasks[0].artifactPath !== null);
    deepEqual(Array.from(readFileSync(view.tasks[0].artifactPath as string)), [1, 2, 3]);

    // The caller may delete the source file; stored bytes remain intact.
    rmSync(newSource);
    const reread = ctx.queue.getBatch("batch-1");
    ok(reread !== null);
    deepEqual(Array.from(reread.tasks[0].artifactBytes as Buffer), [1, 2, 3]);
  } finally {
    ctx.cleanup();
  }
});

test("mixed priorities, multi-camera batches and expired reclaim follow queue order", () => {
  const ctx = makeContext();
  try {
    ctx.queue.enqueueBatch({
      batchId: "batch-a",
      priority: 2,
      cameras: [{ cameraId: "a1" }, { cameraId: "a2" }],
    });
    ctx.queue.enqueueBatch({
      batchId: "batch-b",
      priority: 1,
      cameras: [{ cameraId: "b1" }, { cameraId: "b2" }],
    });
    ctx.queue.enqueueBatch({
      batchId: "batch-c",
      priority: 2,
      cameras: [{ cameraId: "c1" }],
    });

    // First claim goes to the highest-priority batch.
    const b1First = ctx.queue.claim();
    ok(b1First !== null);
    equal(b1First.cameraId, "b1");

    // Its worker disappears; after the lease expires the same task is
    // claimable again, still ahead of everything else in the original order.
    ctx.clock.advance(LEASE_MS);
    const b1Second = ctx.queue.claim();
    ok(b1Second !== null);
    equal(b1Second.cameraId, "b1");
    ok(b1Second.attemptId !== b1First.attemptId);

    // Remaining claims follow priority, batch enqueue order, camera order.
    const rest = [
      ctx.queue.claim(),
      ctx.queue.claim(),
      ctx.queue.claim(),
      ctx.queue.claim(),
    ];
    rest.forEach((claimed) => ok(claimed !== null));
    deepEqual(
      rest.map((claimed) => (claimed as { cameraId: string }).cameraId),
      ["b2", "a1", "a2", "c1"],
    );
    equal(ctx.queue.claim(), null);
    const claimedB2 = rest[0];
    ok(claimedB2 !== null);

    // Nothing is complete yet.
    equal((ctx.queue.getBatch("batch-b") as { complete: boolean }).complete, false);

    const srcB1 = ctx.writeSource("b1.bin", [1, 1, 1]);
    ok(ctx.queue.submitResult(b1Second.attemptId, srcB1).ok);
    // The expired first attempt of b1 is rejected even though it was leased first.
    deepEqual(ctx.queue.submitResult(b1First.attemptId, srcB1), {
      ok: false,
      reason: "superseded",
    });
    // Batch b still incomplete: b2 is pending; duplicate confirms of b1
    // must not move the completion condition.
    equal((ctx.queue.getBatch("batch-b") as { complete: boolean }).complete, false);
    ok(ctx.queue.submitResult(b1Second.attemptId, srcB1).ok);
    equal((ctx.queue.getBatch("batch-b") as { complete: boolean }).complete, false);

    // Finish batch b; only then is it complete.
    equal(claimedB2.cameraId, "b2");
    const srcB2 = ctx.writeSource("b2.bin", [2, 2, 2]);
    ok(ctx.queue.submitResult(claimedB2.attemptId, srcB2).ok);
    const viewB = ctx.queue.getBatch("batch-b");
    ok(viewB !== null);
    equal(viewB.complete, true);
    deepEqual(
      viewB.tasks.map((task) => Array.from(task.artifactBytes as Buffer)),
      [[1, 1, 1], [2, 2, 2]],
    );

    // Re-confirming b1 again must not complete other batches early.
    ok(ctx.queue.submitResult(b1Second.attemptId, srcB1).ok);
    equal((ctx.queue.getBatch("batch-a") as { complete: boolean }).complete, false);
    equal((ctx.queue.getBatch("batch-c") as { complete: boolean }).complete, false);
  } finally {
    ctx.cleanup();
  }
});
