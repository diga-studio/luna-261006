import test from 'node:test';
import assert from 'node:assert/strict';
import { createShaper } from '../src/shaper';
import { ControlledSource, VirtualClock, WriteRecorder, flush } from './helpers';

/**
 * A stream whose next() hangs and a stream whose write() hangs must not
 * stop other streams in the same or other profiles. After cancelling the
 * hung streams, releasing their dangling promises late must not revive
 * them: no further next/write calls, no further bytes.
 */
test('hung next/write do not block others; late resolution after cancel is inert', async () => {
  const clock = new VirtualClock();
  const shaper = createShaper({ rates: { P: 8000, Q: 16000 }, clock });
  const recorder = new WriteRecorder(clock);

  // A: first chunk flows, then next() hangs forever (until released).
  const sourceA = new ControlledSource('A', { sizes: [100, 100], forever: true, hangNextAt: 1 },
    () => recorder.cumulative('A', clock.now()));
  // B: first write resolves, second write hangs forever (until released).
  const sourceB = new ControlledSource('B', { sizes: [500], forever: true },
    () => recorder.cumulative('B', clock.now()));
  let releaseBWrite: (() => void) | null = null;
  let bWriteCalls = 0;
  const writeB = (chunk: Uint8Array): Promise<void> => {
    bWriteCalls += 1;
    recorder.events.push({ stream: 'B', time: clock.now(), bytes: chunk.length });
    if (bWriteCalls === 2) {
      return new Promise<void>((resolve) => {
        releaseBWrite = resolve;
      });
    }
    return Promise.resolve();
  };
  // C: healthy stream in the same profile; D: healthy stream elsewhere.
  const sourceC = new ControlledSource('C', { sizes: [300], forever: true },
    () => recorder.cumulative('C', clock.now()));
  const sourceD = new ControlledSource('D', { sizes: [700], forever: true },
    () => recorder.cumulative('D', clock.now()));

  const handleA = shaper.start('P', sourceA, recorder.writer('A'));
  const handleB = shaper.start('P', sourceB, writeB);
  const handleC = shaper.start('P', sourceC, recorder.writer('C'));
  const handleD = shaper.start('Q', sourceD, recorder.writer('D'));

  await flush(); // let the initial burst happen at t=0
  const duration = 6000;
  while (clock.now() < duration) {
    const next = clock.nextDeadline();
    const step = Math.min(next ?? Infinity, clock.now() + 25, duration);
    clock.advanceTo(step);
    await flush();
  }

  // The hung streams produced only their pre-hang bytes, all at time 0.
  assert.equal(recorder.cumulative('A', duration), 100);
  assert.equal(recorder.cumulative('B', duration), 1000);
  for (const event of recorder.events) {
    if (event.stream === 'A' || event.stream === 'B') {
      assert.equal(event.time, 0, `${event.stream} wrote at ${event.time}`);
    }
  }

  // Healthy streams kept progressing the whole time.
  const cLate = recorder.bytesIn(['C'], 4000, 6000);
  const dLate = recorder.bytesIn(['D'], 4000, 6000);
  assert.ok(cLate >= 8000 * 2 - 4096, `C starved: ${cLate} bytes in last 2s`);
  assert.ok(dLate >= 16000 * 2 - 4096, `D starved: ${dLate} bytes in last 2s`);
  // Same-profile ceiling still holds with the hung streams present.
  assert.ok(recorder.bytesIn(null, 0, 6000) <= 8000 * 6 + 16000 * 6 + 2 * 4096);

  // Cancelling the hung streams settles their done immediately, without
  // waiting for the dangling promises.
  handleA.cancel();
  handleB.cancel();
  assert.deepEqual(await handleA.done, { status: 'cancelled' });
  assert.deepEqual(await handleB.done, { status: 'cancelled' });
  const aNextCalls = sourceA.nextCalls;
  const bWrites = bWriteCalls;
  const aBytes = recorder.cumulative('A', duration);
  const bBytes = recorder.cumulative('B', duration);

  // Late resolution of the dangling promises must not revive anything.
  sourceA.releaseHang!();
  releaseBWrite!();
  await flush();
  while (clock.now() < duration + 2000) {
    const next = clock.nextDeadline();
    const step = Math.min(next ?? Infinity, clock.now() + 25, duration + 2000);
    clock.advanceTo(step);
    await flush();
  }
  assert.equal(sourceA.nextCalls, aNextCalls, 'cancelled stream pulled again');
  assert.equal(bWriteCalls, bWrites, 'cancelled stream wrote again');
  assert.equal(recorder.cumulative('A', duration + 2000), aBytes);
  assert.equal(recorder.cumulative('B', duration + 2000), bBytes);

  // Healthy streams still alive; cancel them too and expect a clean stop.
  handleC.cancel();
  handleD.cancel();
  await flush();
  assert.deepEqual(await handleC.done, { status: 'cancelled' });
  assert.deepEqual(await handleD.done, { status: 'cancelled' });
  assert.equal(clock.pendingCount, 0, 'timers left behind');
  sourceA.assertNoProtocolViolations();
  sourceB.assertNoProtocolViolations();
  sourceC.assertNoProtocolViolations();
  sourceD.assertNoProtocolViolations();
});
