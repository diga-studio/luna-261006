import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { test } from "node:test";
import { LEASE_MS, RenderQueue } from "../src/index";
import { makeContext } from "./helpers";

test("idempotent enqueue: same id and content maps to the original batch", () => {
  const ctx = makeContext();
  try {
    const input = {
      batchId: "batch-x",
      priority: 2 as const,
      cameras: [{ cameraId: "cam-1" }, { cameraId: "cam-2" }],
    };
    const first = ctx.queue.enqueueBatch(input);
    equal(first.alreadyExisted, false);

    const retry = ctx.queue.enqueueBatch(input);
    equal(retry.alreadyExisted, true);
    deepEqual(retry.taskIds, first.taskIds);

    // No duplicate tasks were created: exactly two claims, then empty.
    ok(ctx.queue.claim() !== null);
    ok(ctx.queue.claim() !== null);
    equal(ctx.queue.claim(), null);

    // Same id with different content is rejected.
    throws(() =>
      ctx.queue.enqueueBatch({
        batchId: "batch-x",
        priority: 2,
        cameras: [{ cameraId: "cam-1" }],
      }),
    );
    throws(() =>
      ctx.queue.enqueueBatch({
        batchId: "batch-x",
        priority: 3,
        cameras: [{ cameraId: "cam-1" }, { cameraId: "cam-2" }],
      }),
    );
  } finally {
    ctx.cleanup();
  }
});

test("lease boundary: submit before expiry ok, at expiry rejected and re-claimable", () => {
  const ctx = makeContext();
  try {
    ctx.queue.enqueueBatch({
      batchId: "batch-lease",
      priority: 1,
      cameras: [{ cameraId: "cam-a" }, { cameraId: "cam-b" }],
    });

    const first = ctx.queue.claim();
    ok(first !== null);
    equal(first.expiresAt - first.leasedAt, LEASE_MS);

    // Not re-claimable while the lease is still valid... but cam-b is.
    const second = ctx.queue.claim();
    ok(second !== null);
    equal(second.cameraId, "cam-b");
    equal(ctx.queue.claim(), null);

    // At the exact expiry moment the attempt can no longer complete.
    ctx.clock.advance(LEASE_MS);
    const src = ctx.writeSource("late.bin", [7, 7]);
    deepEqual(ctx.queue.submitResult(first.attemptId, src), {
      ok: false,
      reason: "lease-expired",
    });

    // ...and the task is claimable again, ahead of other queued work.
    const reclaimed = ctx.queue.claim();
    ok(reclaimed !== null);
    equal(reclaimed.cameraId, "cam-a");
    ok(reclaimed.attemptId !== first.attemptId);

    // The new attempt can complete within its own lease.
    ok(ctx.queue.submitResult(reclaimed.attemptId, src).ok);
    equal((ctx.queue.getBatch("batch-lease") as { complete: boolean }).complete, false);
  } finally {
    ctx.cleanup();
  }
});

test("resubmitting the successful attempt: same bytes replay, different bytes rejected", () => {
  const ctx = makeContext();
  try {
    ctx.queue.enqueueBatch({
      batchId: "batch-replay",
      priority: 1,
      cameras: [{ cameraId: "cam-a" }],
    });
    const claimed = ctx.queue.claim();
    ok(claimed !== null);
    const src = ctx.writeSource("result.bin", [4, 5, 6]);
    const accepted = ctx.queue.submitResult(claimed.attemptId, src);
    ok(accepted.ok);

    // Same bytes: returns the original success.
    const replay = ctx.queue.submitResult(claimed.attemptId, src);
    deepEqual(replay, accepted);

    // Different bytes: rejected, stored artifact untouched.
    const other = ctx.writeSource("other.bin", [4, 5, 7]);
    deepEqual(ctx.queue.submitResult(claimed.attemptId, other), {
      ok: false,
      reason: "conflicting-bytes",
    });
    const view = ctx.queue.getBatch("batch-replay");
    ok(view !== null);
    deepEqual(Array.from(view.tasks[0].artifactBytes as Buffer), [4, 5, 6]);

    // Succeeded tasks never participate in claiming again.
    equal(ctx.queue.claim(), null);
  } finally {
    ctx.cleanup();
  }
});

test("restart preserves leases: no extension, no immediate reassignment", () => {
  const ctx = makeContext();
  try {
    ctx.queue.enqueueBatch({
      batchId: "batch-restart",
      priority: 1,
      cameras: [{ cameraId: "cam-a" }],
    });
    const claimed = ctx.queue.claim();
    ok(claimed !== null);
    ctx.clock.advance(30_000); // half the lease passes
    ctx.queue.close();

    // Reopen against the same data dir (simulated restart).
    const reopened = new RenderQueue({ dataDir: ctx.dir, now: ctx.clock.now });
    try {
      // Lease still valid: nothing to claim, and the expiry is unchanged.
      equal(reopened.claim(), null);
      ctx.clock.advance(29_999);
      equal(reopened.claim(), null);

      // At the original expiry moment the task becomes claimable again.
      ctx.clock.advance(1);
      const reclaimed = reopened.claim();
      ok(reclaimed !== null);
      equal(reclaimed.taskId, claimed.taskId);
      equal(reclaimed.expiresAt - reclaimed.leasedAt, LEASE_MS);

      // The pre-restart attempt is now stale (reclaimed by a newer attempt).
      const src = ctx.writeSource("after-restart.bin", [8]);
      deepEqual(reopened.submitResult(claimed.attemptId, src), {
        ok: false,
        reason: "superseded",
      });
      ok(reopened.submitResult(reclaimed.attemptId, src).ok);
    } finally {
      reopened.close();
    }
  } finally {
    ctx.cleanup();
  }
});

test("unknown attempts and missing source files are rejected", () => {
  const ctx = makeContext();
  try {
    ctx.queue.enqueueBatch({
      batchId: "batch-errors",
      priority: 1,
      cameras: [{ cameraId: "cam-a" }],
    });
    const claimed = ctx.queue.claim();
    ok(claimed !== null);
    deepEqual(ctx.queue.submitResult(999_999, "whatever"), {
      ok: false,
      reason: "unknown-attempt",
    });
    deepEqual(ctx.queue.submitResult(claimed.attemptId, "/no/such/file.bin"), {
      ok: false,
      reason: "artifact-missing",
    });
    // Task is still leased to the same attempt afterwards.
    equal(ctx.queue.claim(), null);
  } finally {
    ctx.cleanup();
  }
});

test("getBatch reports per-camera status and null for unknown batches", () => {
  const ctx = makeContext();
  try {
    equal(ctx.queue.getBatch("nope"), null);
    ctx.queue.enqueueBatch({
      batchId: "batch-view",
      priority: 4,
      cameras: [{ cameraId: "cam-1" }, { cameraId: "cam-2" }],
    });
    const before = ctx.queue.getBatch("batch-view");
    ok(before !== null);
    equal(before.complete, false);
    deepEqual(
      before.tasks.map((task) => [task.cameraId, task.status]),
      [["cam-1", "pending"], ["cam-2", "pending"]],
    );

    const claimed = ctx.queue.claim();
    ok(claimed !== null);
    const leased = ctx.queue.getBatch("batch-view");
    ok(leased !== null);
    equal(leased.tasks[0].status, "leased");
    equal(leased.tasks[0].artifactPath, null);
    equal(leased.tasks[0].artifactBytes, null);
  } finally {
    ctx.cleanup();
  }
});
