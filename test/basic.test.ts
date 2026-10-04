import test from 'node:test';
import assert from 'node:assert/strict';
import { createShaper } from '../src/shaper';
import { ControlledSource, VirtualClock, WriteRecorder, flush } from './helpers';

test('finite source: all bytes delivered losslessly, in order, then done completes', async () => {
  const clock = new VirtualClock();
  const shaper = createShaper({ rates: { P: 64000 }, clock });
  const sizes = [3, 1000, 65536, 7, 128];
  const written: number[] = [];
  const source = new ControlledSource('s', { sizes }, () =>
    written.reduce((a, b) => a + b, 0),
  );
  const handle = shaper.start('P', source, async (chunk) => {
    written.push(...chunk);
  });
  for (let i = 0; i < 200; i++) {
    clock.advanceBy(100);
    await flush();
  }
  const result = await handle.done;
  assert.deepEqual(result, { status: 'completed' });
  const expected: number[] = [];
  for (const size of sizes) {
    for (let i = 0; i < size; i++) expected.push(1);
  }
  assert.deepEqual(written, expected);
  source.assertNoProtocolViolations();
  assert.equal(clock.pendingCount, 0);
});

test('done completes only after the final write promise resolves', async () => {
  const clock = new VirtualClock();
  const shaper = createShaper({ rates: { P: 64000 }, clock });
  let releaseLastWrite: (() => void) | null = null;
  let writeCalls = 0;
  const source = new ControlledSource('s', { sizes: [10] }, () => 0);
  const handle = shaper.start('P', source, () => {
    writeCalls += 1;
    return new Promise<void>((resolve) => {
      releaseLastWrite = resolve;
    });
  });
  await flush();
  assert.equal(writeCalls, 1);
  let settled = false;
  void handle.done.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false, 'done must wait for the dangling write');
  releaseLastWrite!();
  await flush();
  // The source signals done after the chunk is fully written.
  clock.advanceBy(1);
  await flush();
  assert.equal(settled, true);
  assert.deepEqual(await handle.done, { status: 'completed' });
});

test('cancel terminates immediately without waiting for dangling promises', async () => {
  const clock = new VirtualClock();
  const shaper = createShaper({ rates: { P: 8000 }, clock });
  let writeCalls = 0;
  const source = new ControlledSource('s', { sizes: [65536], forever: true }, () => 0);
  const handle = shaper.start('P', source, () => {
    writeCalls += 1;
    return new Promise<void>(() => {}); // never resolves
  });
  await flush();
  assert.equal(writeCalls, 1);
  handle.cancel();
  const result = await handle.done;
  assert.deepEqual(result, { status: 'cancelled' });
  clock.advanceBy(10000);
  await flush();
  assert.equal(writeCalls, 1, 'no write after cancel');
  assert.equal(source.nextCalls, 1, 'no next after cancel');
  assert.equal(clock.pendingCount, 0);
});

test('cancel before the first chunk arrives: nothing is ever written', async () => {
  const clock = new VirtualClock();
  const shaper = createShaper({ rates: { P: 8000 }, clock });
  const source = new ControlledSource('s', { sizes: [100], hangNextAt: 0 }, () => 0);
  let writeCalls = 0;
  const handle = shaper.start('P', source, async () => {
    writeCalls += 1;
  });
  handle.cancel();
  assert.deepEqual(await handle.done, { status: 'cancelled' });
  source.releaseHang!();
  await flush();
  clock.advanceBy(1000);
  await flush();
  assert.equal(writeCalls, 0);
  assert.equal(source.nextCalls, 1);
  assert.equal(clock.pendingCount, 0);
});

test('source failure fails only its own transfer', async () => {
  const clock = new VirtualClock();
  const shaper = createShaper({ rates: { P: 8000 }, clock });
  const recorder = new WriteRecorder(clock);
  const bad = new ControlledSource('bad', { sizes: [100], failNextAt: 0 }, () => 0);
  const good = new ControlledSource('good', { sizes: [300], forever: true }, () =>
    recorder.cumulative('good', clock.now()),
  );
  const badHandle = shaper.start('P', bad, recorder.writer('bad'));
  const goodHandle = shaper.start('P', good, recorder.writer('good'));
  await flush();
  const result = await badHandle.done;
  assert.equal(result.status, 'failed');
  assert.match(String((result as { reason: unknown }).reason), /source failure/);
  clock.advanceBy(2000);
  await flush();
  assert.ok(
    recorder.cumulative('good', clock.now()) > 4096,
    'sibling transfer keeps progressing',
  );
  goodHandle.cancel();
  await flush();
  assert.equal(clock.pendingCount, 0);
});

test('write rejection fails the transfer; late source events do not revive it', async () => {
  const clock = new VirtualClock();
  const shaper = createShaper({ rates: { P: 8000 }, clock });
  const source = new ControlledSource('s', { sizes: [100], forever: true }, () => 0);
  const handle = shaper.start('P', source, () => Promise.reject(new Error('sink down')));
  await flush();
  const result = await handle.done;
  assert.equal(result.status, 'failed');
  assert.match(String((result as { reason: unknown }).reason), /sink down/);
  clock.advanceBy(5000);
  await flush();
  assert.equal(source.nextCalls, 1, 'no further pulls after failure');
  assert.equal(clock.pendingCount, 0);
});

test('empty source completes with zero writes', async () => {
  const clock = new VirtualClock();
  const shaper = createShaper({ rates: { P: 8000 }, clock });
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  let writeCalls = 0;
  const handle = shaper.start('P', source, async () => {
    writeCalls += 1;
  });
  await flush();
  assert.deepEqual(await handle.done, { status: 'completed' });
  assert.equal(writeCalls, 0);
  assert.equal(clock.pendingCount, 0);
});

test('invalid configuration is rejected', async () => {
  const clock = new VirtualClock();
  assert.throws(() => createShaper({ rates: { P: 0 }, clock }));
  assert.throws(() => createShaper({ rates: { P: Number.NaN }, clock }));
  const shaper = createShaper({ rates: { P: 8000 }, clock });
  const source = new ControlledSource('s', { sizes: [1] }, () => 0);
  assert.throws(() => shaper.start('Q', source, async () => {}), /unknown profileId/);
});

test('source protocol violation (oversized chunk) fails the transfer', async () => {
  const clock = new VirtualClock();
  const shaper = createShaper({ rates: { P: 8000 }, clock });
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (sent) return Promise.resolve({ done: true, value: undefined });
          sent = true;
          return Promise.resolve({ done: false, value: new Uint8Array(70000) });
        },
      };
    },
  };
  const handle = shaper.start('P', source, async () => {});
  await flush();
  const result = await handle.done;
  assert.equal(result.status, 'failed');
  assert.equal(clock.pendingCount, 0);
});
