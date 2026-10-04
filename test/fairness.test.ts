import test from 'node:test';
import assert from 'node:assert/strict';
import { createShaper } from '../src/shaper';
import { ControlledSource, VirtualClock, WriteRecorder, flush } from './helpers';

const EPS = 1e-6;

/**
 * One profile shared by long streams with wildly different input chunking
 * (7-byte vs 65536-byte chunks), plus a stream joining mid-flight. Verifies
 * the shared rate ceiling on every window, sustained throughput on every
 * window >= 1s, and byte-level fairness between simultaneously active
 * streams - not just total elapsed time.
 */
test('shared rate, sustained throughput, and byte fairness across chunk sizes', async () => {
  const clock = new VirtualClock();
  const R = 8000; // bytes/second, shared by profile P
  const shaper = createShaper({ rates: { P: R }, clock });
  const recorder = new WriteRecorder(clock);

  const maxOutstandingWrite: Record<string, number> = {};
  const trackedWriter = (stream: string) => {
    let pending = 0;
    maxOutstandingWrite[stream] = 0;
    const record = recorder.writer(stream);
    return async (chunk: Uint8Array) => {
      pending += 1;
      maxOutstandingWrite[stream] = Math.max(maxOutstandingWrite[stream] ?? 0, pending);
      try {
        await record(chunk);
      } finally {
        pending -= 1;
      }
    };
  };

  const writtenSoFar = (stream: string) => () =>
    recorder.cumulative(stream, clock.now());

  const sourceA = new ControlledSource('A', { sizes: [7], forever: true }, writtenSoFar('A'));
  const sourceB = new ControlledSource('B', { sizes: [65536], forever: true }, writtenSoFar('B'));
  const sourceC = new ControlledSource('C', { sizes: [1000], forever: true }, writtenSoFar('C'));

  const handles = [
    shaper.start('P', sourceA, trackedWriter('A')),
    shaper.start('P', sourceB, trackedWriter('B')),
  ];

  const joinAt = 4000;
  const duration = 12000;
  let cStarted = false;
  // Advance the clock one timer at a time, letting promise continuations
  // run at each instant before the clock moves on ("the clock fires its
  // callbacks one by one, exactly on time").
  while (clock.now() < duration) {
    if (!cStarted && clock.now() >= joinAt) {
      handles.push(shaper.start('P', sourceC, trackedWriter('C')));
      cStarted = true;
    }
    const next = clock.nextDeadline();
    const step = Math.min(next ?? Infinity, clock.now() + 25, duration);
    clock.advanceTo(step);
    await flush();
  }
  assert.ok(cStarted);

  // Every write is at most 1024 bytes.
  for (const event of recorder.events) {
    assert.ok(event.bytes <= 1024, `write of ${event.bytes} bytes at ${event.time}`);
  }

  const { times, prefix } = recorder.prefixSums();
  const bytesUpTo = (t: number): number => {
    // Bytes with event time <= t via binary search over distinct times.
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? 0 : prefix[lo - 1]!;
  };

  // Shared-rate ceiling and sustained throughput on every event-aligned
  // window (t1, t2].
  for (let i = 0; i < times.length; i++) {
    for (let j = i + 1; j < times.length; j++) {
      const t1 = times[i]!;
      const t2 = times[j]!;
      const bytes = bytesUpTo(t2) - bytesUpTo(t1);
      const seconds = (t2 - t1) / 1000;
      assert.ok(
        bytes <= R * seconds + 4096 + EPS,
        `ceiling violated on (${t1}, ${t2}]: ${bytes} > ${R * seconds + 4096}`,
      );
      if (t2 - t1 >= 1000) {
        assert.ok(
          bytes >= R * seconds - 4096 - EPS,
          `throughput violated on (${t1}, ${t2}]: ${bytes} < ${R * seconds - 4096}`,
        );
      }
    }
  }

  // Byte-level fairness: over ANY common active window (t1, t2], the
  // outputs of any two continuously-supplied streams differ by at most
  // 4096 bytes, regardless of input chunking.
  const joins: Record<string, number> = { A: 0, B: 0, C: joinAt };
  const streams = ['A', 'B', 'C'];
  const perStream = new Map(
    streams.map((stream) => [stream, recorder.prefixSums(stream)]),
  );
  const streamBytesUpTo = (stream: string, t: number): number => {
    const sums = perStream.get(stream)!;
    let lo = 0;
    let hi = sums.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sums.times[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? 0 : sums.prefix[lo - 1]!;
  };
  for (let a = 0; a < streams.length; a++) {
    for (let b = a + 1; b < streams.length; b++) {
      const sa = streams[a]!;
      const sb = streams[b]!;
      const start = Math.max(joins[sa]!, joins[sb]!);
      const windowTimes = times.filter((t) => t > start);
      for (let i = 0; i < windowTimes.length; i++) {
        for (let j = i + 1; j < windowTimes.length; j++) {
          const t1 = windowTimes[i]!;
          const t2 = windowTimes[j]!;
          const outA =
            streamBytesUpTo(sa, t2) - streamBytesUpTo(sa, t1);
          const outB =
            streamBytesUpTo(sb, t2) - streamBytesUpTo(sb, t1);
          assert.ok(
            Math.abs(outA - outB) <= 4096,
            `unfair on (${t1}, ${t2}]: ${sa}=${outA} ${sb}=${outB}`,
          );
        }
      }
    }
  }

  // The late-joining stream must not retroactively catch up: its share
  // after joining matches the others' share over the same interval.
  const tail = 2000;
  const tailShares = streams.map(
    (s) => recorder.cumulative(s, duration) - recorder.cumulative(s, duration - tail),
  );
  for (const bytes of tailShares) {
    assert.ok(
      Math.abs(bytes - (R * tail) / 1000 / 3) <= 4096,
      `tail share ${bytes} deviates from fair share`,
    );
  }

  // Backpressure protocol: at most one outstanding next/write per stream.
  sourceA.assertNoProtocolViolations();
  sourceB.assertNoProtocolViolations();
  sourceC.assertNoProtocolViolations();
  assert.ok(sourceA.maxOutstandingNext <= 1);
  assert.ok(sourceB.maxOutstandingNext <= 1);
  assert.ok(sourceC.maxOutstandingNext <= 1);
  for (const stream of streams) {
    assert.ok(
      maxOutstandingWrite[stream]! <= 1,
      `${stream} had ${maxOutstandingWrite[stream]} concurrent writes`,
    );
  }

  // Cancelling everything settles every done and leaves no timers behind.
  for (const handle of handles) handle.cancel();
  await flush();
  for (const handle of handles) {
    assert.deepEqual(await handle.done, { status: 'cancelled' });
  }
  assert.equal(clock.pendingCount, 0);
});
