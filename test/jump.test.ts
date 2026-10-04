import test from 'node:test';
import assert from 'node:assert/strict';
import { createShaper } from '../src/shaper';
import { ControlledSource, VirtualClock, WriteRecorder, flush } from './helpers';

/**
 * After the allowance is exhausted, a huge clock jump must not unleash a
 * catch-up flood: at most the 4096-byte burst allowance is released.
 * Cancelling all transfers settles every done and leaves no timers.
 */
test('large clock jump releases at most the burst allowance, never a catch-up flood', async () => {
  const clock = new VirtualClock();
  const R = 8000;
  const shaper = createShaper({ rates: { P: R }, clock });
  const recorder = new WriteRecorder(clock);
  const source = new ControlledSource('S', { sizes: [65536], forever: true },
    () => recorder.cumulative('S', clock.now()));
  const handle = shaper.start('P', source, recorder.writer('S'));

  await flush();
  // Run for 2s: the initial burst is spent and the stream is rate-limited.
  while (clock.now() < 2000) {
    const next = clock.nextDeadline();
    clock.advanceTo(Math.min(next ?? Infinity, clock.now() + 25, 2000));
    await flush();
  }
  const before = recorder.cumulative('S', clock.now());
  assert.ok(before >= 4096 + R * 2 - 4096, `warm-up too low: ${before}`);
  assert.ok(before <= 4096 + R * 2 + 4096, `warm-up too high: ${before}`);

  // Jump 10 minutes in one step.
  const jumpTarget = clock.now() + 600000;
  clock.advanceBy(600000);
  await flush();
  const afterJump = recorder.cumulative('S', clock.now());
  // The idle gap tops the bucket up by at most the 4096-byte burst
  // allowance; the only other bytes are the single quantum honestly
  // accrued between the last pacing tick and the jump.
  assert.ok(
    afterJump - before <= 4096 + 1024,
    `catch-up flood after jump: ${afterJump - before} bytes`,
  );
  // At the post-jump instant itself, at most the burst allowance comes out.
  assert.ok(
    recorder.bytesIn(['S'], jumpTarget - 1, jumpTarget) <= 4096,
    `burst at jump instant: ${recorder.bytesIn(['S'], jumpTarget - 1, jumpTarget)} bytes`,
  );
  assert.ok(afterJump - before > 0, 'no progress after jump');

  // Nothing more comes out without the clock advancing further.
  await flush();
  assert.equal(recorder.cumulative('S', clock.now()), afterJump);

  // Afterwards the stream resumes its normal sustained rate.
  const resumeStart = clock.now();
  while (clock.now() < resumeStart + 2000) {
    const next = clock.nextDeadline();
    clock.advanceTo(Math.min(next ?? Infinity, clock.now() + 25, resumeStart + 2000));
    await flush();
  }
  const resumed = recorder.bytesIn(['S'], resumeStart, resumeStart + 2000);
  assert.ok(resumed >= R * 2 - 4096, `resumed throughput too low: ${resumed}`);
  assert.ok(resumed <= R * 2 + 4096, `resumed throughput too high: ${resumed}`);

  // Cancelling everything settles done and leaves no timers behind.
  handle.cancel();
  assert.deepEqual(await handle.done, { status: 'cancelled' });
  await flush();
  assert.equal(clock.pendingCount, 0, 'timers left behind');
  source.assertNoProtocolViolations();
});

test('cancelling all transfers mid-burst leaves no timers and settles every done', async () => {
  const clock = new VirtualClock();
  const shaper = createShaper({ rates: { P: 8000, Q: 4000 }, clock });
  const recorder = new WriteRecorder(clock);
  const mk = (name: string, size: number) =>
    new ControlledSource(name, { sizes: [size], forever: true },
      () => recorder.cumulative(name, clock.now()));
  const sources = [mk('a', 7), mk('b', 65536), mk('c', 1000), mk('d', 100)];
  const handles = [
    shaper.start('P', sources[0]!, recorder.writer('a')),
    shaper.start('P', sources[1]!, recorder.writer('b')),
    shaper.start('P', sources[2]!, recorder.writer('c')),
    shaper.start('Q', sources[3]!, recorder.writer('d')),
  ];
  await flush();
  while (clock.now() < 500) {
    const next = clock.nextDeadline();
    clock.advanceTo(Math.min(next ?? Infinity, clock.now() + 7, 500));
    await flush();
  }
  for (const handle of handles) handle.cancel();
  await flush();
  for (const handle of handles) {
    assert.deepEqual(await handle.done, { status: 'cancelled' });
  }
  assert.equal(clock.pendingCount, 0, 'timers left behind');
  // No writes and no pulls happen after cancellation, even as time passes.
  const eventCount = recorder.events.length;
  const nextCalls = sources.map((s) => s.nextCalls);
  clock.advanceBy(10000);
  await flush();
  assert.equal(recorder.events.length, eventCount);
  assert.deepEqual(sources.map((s) => s.nextCalls), nextCalls);
  assert.equal(clock.pendingCount, 0);
  for (const source of sources) source.assertNoProtocolViolations();
});
