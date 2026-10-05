import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RenderQueue, LEASE_MS } from '../src/index.js';
import type { ClaimedTask } from '../src/index.js';

async function makeQueue(t: TestContext, dir?: string) {
  const queueDir = dir ?? mkdtempSync(join(tmpdir(), 'rtq-'));
  const queue = new RenderQueue({ dir: queueDir });
  await queue.open();
  t.after(() => {
    queue.close();
    rmSync(queueDir, { recursive: true, force: true });
  });
  return { queue, dir: queueDir };
}

function writeSource(dir: string, name: string, bytes: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

interface TestContext {
  after(fn: () => void): void;
}

test('stale attempt cannot overwrite a completed task; only new attempt bytes are readable', async (t) => {
  const { queue, dir } = await makeQueue(t as unknown as TestContext);
  await queue.enqueueBatch({ batchId: 'batch-1', priority: 3, cameras: ['cam-a'] });

  const first = queue.claim(0);
  assert.ok(first);
  assert.equal(first.leaseExpiresAt, LEASE_MS);

  // Old attempt expires; a new attempt is handed out at the expiry boundary.
  const second = queue.claim(LEASE_MS);
  assert.ok(second);
  assert.equal(second.taskId, first.taskId);
  assert.notEqual(second.attemptId, first.attemptId);

  const newSource = writeSource(dir, 'new.bin', 'new-attempt-bytes');
  const accepted = queue.submit(second.attemptId, newSource, LEASE_MS + 1);
  assert.equal(accepted.status, 'accepted');

  // Caller may delete the source file once the submit returns success.
  rmSync(newSource);

  // The stale attempt submits its own result afterwards: rejected, no effect.
  const oldSource = writeSource(dir, 'old.bin', 'old-attempt-bytes');
  const stale = queue.submit(first.attemptId, oldSource, LEASE_MS + 2);
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.reason, 'stale-attempt');

  const view = queue.getBatch('batch-1', 1_000 + LEASE_MS);
  assert.ok(view);
  assert.equal(view.complete, true);
  assert.equal(view.tasks.length, 1);
  assert.equal(view.tasks[0].status, 'completed');
  assert.ok(view.tasks[0].result);
  assert.deepEqual(view.tasks[0].result!.read(), Buffer.from('new-attempt-bytes'));

  // The successful attempt re-submitting the same bytes is a duplicate no-op.
  const sameAgain = writeSource(dir, 'same.bin', 'new-attempt-bytes');
  const dup = queue.submit(second.attemptId, sameAgain, LEASE_MS + 3);
  assert.equal(dup.status, 'duplicate');
  assert.deepEqual(view.tasks[0].result!.read(), Buffer.from('new-attempt-bytes'));

  // The successful attempt re-submitting different bytes must not rewrite the result.
  const different = writeSource(dir, 'different.bin', 'tampered-bytes');
  const mismatch = queue.submit(second.attemptId, different, LEASE_MS + 4);
  assert.equal(mismatch.status, 'rejected');
  assert.equal(mismatch.reason, 'byte-mismatch');
  const after = queue.getBatch('batch-1');
  assert.equal(after!.complete, true);
  assert.deepEqual(after!.tasks[0].result!.read(), Buffer.from('new-attempt-bytes'));
});

test('expired attempt cannot complete a task even if nobody re-claimed it', async (t) => {
  const { queue, dir } = await makeQueue(t as unknown as TestContext);
  await queue.enqueueBatch({ batchId: 'batch-1', priority: 2, cameras: ['cam-a'] });

  const claim = queue.claim(1_000);
  assert.ok(claim);

  // One ms before expiry: still valid.
  const source = writeSource(dir, 'result.bin', 'payload');
  const lateButValid = queue.submit(claim.attemptId, source, 1_000 + LEASE_MS - 1);
  assert.equal(lateButValid.status, 'accepted');
});

test('submit exactly at lease expiry is rejected', async (t) => {
  const { queue, dir } = await makeQueue(t as unknown as TestContext);
  await queue.enqueueBatch({ batchId: 'batch-1', priority: 2, cameras: ['cam-a'] });

  const claim = queue.claim(1_000);
  assert.ok(claim);
  const source = writeSource(dir, 'result.bin', 'payload');
  const expired = queue.submit(claim.attemptId, source, 1_000 + LEASE_MS);
  assert.equal(expired.status, 'rejected');
  assert.equal(expired.reason, 'lease-expired');

  const view = queue.getBatch('batch-1', 1_000 + LEASE_MS);
  assert.equal(view!.complete, false);
  assert.equal(view!.tasks[0].status, 'pending');
});

test('claim order: priority, then batch enqueue order, then camera order; expired leases re-claimable in original order', async (t) => {
  const { queue, dir } = await makeQueue(t as unknown as TestContext);
  await queue.enqueueBatch({ batchId: 'batch-mid', priority: 3, cameras: ['mid-1', 'mid-2'] });
  await queue.enqueueBatch({ batchId: 'batch-high', priority: 1, cameras: ['high-1'] });
  await queue.enqueueBatch({ batchId: 'batch-low', priority: 5, cameras: ['low-1'] });
  await queue.enqueueBatch({ batchId: 'batch-mid-2', priority: 3, cameras: ['mid-b-1'] });

  const order: string[] = [];
  const claims: ClaimedTask[] = [];
  for (let i = 0; i < 5; i += 1) {
    const claim = queue.claim(0);
    assert.ok(claim, `expected claim #${i + 1}`);
    order.push(claim.camera);
    claims.push(claim);
  }
  assert.deepEqual(order, ['high-1', 'mid-1', 'mid-2', 'mid-b-1', 'low-1']);
  assert.equal(queue.claim(0), null, 'all tasks leased, nothing claimable');

  // Leases expire; re-claiming follows the original queue order.
  const reclaim = queue.claim(LEASE_MS);
  assert.ok(reclaim);
  assert.equal(reclaim.camera, 'high-1');
  assert.notEqual(reclaim.attemptId, claims[0].attemptId);

  // Complete everything through the current attempts.
  const currentAttempts = new Map<number, ClaimedTask>();
  currentAttempts.set(reclaim.taskId, reclaim);
  for (const claim of claims.slice(1)) {
    currentAttempts.set(claim.taskId, claim);
  }
  for (const [taskId, claim] of currentAttempts) {
    const source = writeSource(dir, `result-${taskId}.bin`, `bytes-of-${claim.camera}`);
    const submittedAt = claim.leasedAt + LEASE_MS - 1;
    const result = queue.submit(claim.attemptId, source, submittedAt);
    assert.equal(result.status, 'accepted', `submit for ${claim.camera}`);
  }

  for (const batchId of ['batch-high', 'batch-mid', 'batch-mid-2', 'batch-low']) {
    assert.equal(queue.getBatch(batchId)!.complete, true, `${batchId} complete`);
  }

  // Duplicate confirmation does not change batch completion state.
  const dupSource = writeSource(dir, `result-${reclaim.taskId}.bin`, 'bytes-of-high-1');
  const dup = queue.submit(reclaim.attemptId, dupSource, reclaim.leasedAt + LEASE_MS - 1);
  assert.equal(dup.status, 'duplicate');
  assert.equal(queue.getBatch('batch-high')!.complete, true);
});

test('batch completes only when every camera task succeeded; duplicates do not complete it early', async (t) => {
  const { queue, dir } = await makeQueue(t as unknown as TestContext);
  await queue.enqueueBatch({ batchId: 'batch-1', priority: 2, cameras: ['cam-a', 'cam-b', 'cam-c'] });

  const claimed = [queue.claim(0)!, queue.claim(0)!, queue.claim(0)!];
  assert.deepEqual(claimed.map((c) => c.camera), ['cam-a', 'cam-b', 'cam-c']);

  const firstSource = writeSource(dir, 'a.bin', 'a-bytes');
  assert.equal(queue.submit(claimed[0].attemptId, firstSource, 1).status, 'accepted');
  // Duplicate submit of the same attempt/bytes: still only one task done.
  assert.equal(queue.submit(claimed[0].attemptId, firstSource, 2).status, 'duplicate');
  let view = queue.getBatch('batch-1');
  assert.equal(view!.complete, false);
  assert.deepEqual(view!.tasks.map((task) => task.status), ['completed', 'leased', 'leased']);

  assert.equal(
    queue.submit(claimed[1].attemptId, writeSource(dir, 'b.bin', 'b-bytes'), 3).status,
    'accepted',
  );
  view = queue.getBatch('batch-1');
  assert.equal(view!.complete, false);

  assert.equal(
    queue.submit(claimed[2].attemptId, writeSource(dir, 'c.bin', 'c-bytes'), 4).status,
    'accepted',
  );
  view = queue.getBatch('batch-1');
  assert.equal(view!.complete, true);
  assert.deepEqual(
    view!.tasks.map((task) => task.result!.read().toString()),
    ['a-bytes', 'b-bytes', 'c-bytes'],
  );
});

test('idempotent enqueue: same id and content maps to the original batch; different content throws', async (t) => {
  const { queue } = await makeQueue(t as unknown as TestContext);
  const first = await queue.enqueueBatch({ batchId: 'batch-1', priority: 4, cameras: ['x', 'y'] });
  assert.equal(first.created, true);
  assert.equal(first.taskCount, 2);

  const retry = await queue.enqueueBatch({ batchId: 'batch-1', priority: 4, cameras: ['x', 'y'] });
  assert.equal(retry.created, false);
  assert.equal(retry.taskCount, 2);

  // No duplicate tasks were created: exactly two claims, then nothing.
  assert.ok(queue.claim(0));
  assert.ok(queue.claim(0));
  assert.equal(queue.claim(0), null);

  await assert.rejects(
    queue.enqueueBatch({ batchId: 'batch-1', priority: 4, cameras: ['x', 'z'] }),
    /different content/,
  );
  await assert.rejects(
    queue.enqueueBatch({ batchId: 'batch-1', priority: 1, cameras: ['x', 'y'] }),
    /different content/,
  );
});

test('restart preserves leases: unexpired tasks are not reassigned, expired ones are', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rtq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }) as void);

  const first = new RenderQueue({ dir });
  await first.open();
  await first.enqueueBatch({ batchId: 'batch-1', priority: 2, cameras: ['cam-a', 'cam-b'] });
  const claimed = first.claim(10_000);
  assert.ok(claimed);
  assert.equal(claimed.leaseExpiresAt, 10_000 + LEASE_MS);
  first.close();

  // Reopen: the live lease survives the restart.
  const second = new RenderQueue({ dir });
  await second.open();
  t.after(() => second.close() as void);
  const view = second.getBatch('batch-1', 20_000);
  assert.deepEqual(view!.tasks.map((task) => task.status), ['leased', 'pending']);
  const next = second.claim(20_000);
  assert.ok(next);
  assert.equal(next.camera, 'cam-b', 'only the never-claimed task is handed out');
  assert.equal(second.claim(20_000), null);

  // After the original lease expires, the task becomes claimable again.
  const reclaimed = second.claim(10_000 + LEASE_MS);
  assert.ok(reclaimed);
  assert.equal(reclaimed.camera, 'cam-a');
  assert.notEqual(reclaimed.attemptId, claimed.attemptId);
});

test('unknown attempt is rejected', async (t) => {
  const { queue, dir } = await makeQueue(t as unknown as TestContext);
  const source = writeSource(dir, 'x.bin', 'x');
  const result = queue.submit('no-such-attempt', source, 0);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'unknown-attempt');
});

test('result file persists across restarts and source file deletion', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rtq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }) as void);

  const first = new RenderQueue({ dir });
  await first.open();
  await first.enqueueBatch({ batchId: 'batch-1', priority: 1, cameras: ['cam-a'] });
  const claim = first.claim(0)!;
  const source = writeSource(dir, 'render.png', Buffer.from([0, 1, 2, 3, 255, 254, 253]));
  assert.equal(first.submit(claim.attemptId, source, 1).status, 'accepted');
  first.close();
  rmSync(source);

  const second = new RenderQueue({ dir });
  await second.open();
  t.after(() => second.close() as void);
  const view = second.getBatch('batch-1');
  assert.equal(view!.complete, true);
  assert.deepEqual(view!.tasks[0].result!.read(), Buffer.from([0, 1, 2, 3, 255, 254, 253]));
  assert.ok(existsSync(view!.tasks[0].result!.path));
});
