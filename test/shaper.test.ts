import { test } from "node:test";
import {
  ok,
  equal,
  deepEqual,
} from "node:assert/strict";
import {
  createShaper,
  CancelledError,
  MAX_WRITE_BYTES,
  type ByteSource,
  type TransferHandle,
  type WriteFn,
} from "../src/index.js";
import { VirtualClock } from "./virtual-clock.js";

interface WriteEvent {
  stream: string;
  t: number;
  n: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function infiniteSource(chunkSize: number): ByteSource {
  return {
    async *[Symbol.asyncIterator]() {
      const chunk = new Uint8Array(chunkSize).fill(0x61);
      for (;;) yield chunk;
    },
  };
}

function bytesInWindow(events: WriteEvent[], t1: number, t2: number): number {
  let sum = 0;
  for (const e of events) if (e.t > t1 && e.t <= t2) sum += e.n;
  return sum;
}

type DoneResult = { status: "resolved" } | { status: "rejected"; err: unknown };

function watch(handle: TransferHandle): Promise<DoneResult> {
  return handle.done.then(
    (): DoneResult => ({ status: "resolved" }),
    (err): DoneResult => ({ status: "rejected", err }),
  );
}

async function expectCancelled(done: Promise<DoneResult>): Promise<void> {
  const r = await done;
  ok(r.status === "rejected", "done must reject on cancel");
  if (r.status === "rejected") ok(r.err instanceof CancelledError);
}

test("shared rate, sustained throughput, byte fairness, late joiner", async () => {
  const clock = new VirtualClock();
  const R = 4096;
  const shaper = createShaper(clock, { p: R });
  const events: WriteEvent[] = [];
  const sent = new Map<string, number>();
  const base = new Map<string, number>();
  const active: string[] = [];

  const recorder = (id: string): WriteFn => {
    active.push(id);
    // A newly joined stream must not replay pre-join traffic: re-base everyone.
    for (const other of active) base.set(other, sent.get(other) ?? 0);
    return (chunk) => {
      events.push({ stream: id, t: clock.now(), n: chunk.length });
      const s = (sent.get(id) ?? 0) + chunk.length;
      sent.set(id, s);
      for (const other of active) {
        const relA = s - (base.get(id) ?? 0);
        const relB = (sent.get(other) ?? 0) - (base.get(other) ?? 0);
        ok(
          Math.abs(relA - relB) <= 4096,
          `fairness violated at t=${clock.now()}: ${id}=${relA} ${other}=${relB}`,
        );
      }
      return Promise.resolve();
    };
  };

  const a = shaper.start("p", infiniteSource(1), recorder("A")); // tiny chunks
  const aDone = watch(a);
  const b = shaper.start("p", infiniteSource(65536), recorder("B")); // huge chunks
  const bDone = watch(b);

  await clock.advance(5000);

  const c = shaper.start("p", infiniteSource(4096), recorder("C")); // joins mid-way
  const cDone = watch(c);

  await clock.advance(5000);
  const T = clock.now();

  a.cancel();
  b.cancel();
  c.cancel();
  await expectCancelled(aDone);
  await expectCancelled(bDone);
  await expectCancelled(cDone);
  equal(clock.pendingTimers, 0, "no leftover timers after cancel");

  // Every write is at most 1024 bytes.
  for (const e of events) ok(e.n <= MAX_WRITE_BYTES, `write too large: ${e.n}`);

  // Rate upper bound and sustained-throughput lower bound on sampled windows.
  for (let t1 = -1; t1 <= T; t1 += 200) {
    for (let t2 = t1 + 100; t2 <= T; t2 += 200) {
      const bytes = bytesInWindow(events, t1, t2);
      const upper = (R * (t2 - t1)) / 1000 + 4096;
      ok(
        bytes <= upper + 1e-6,
        `upper bound violated on (${t1}, ${t2}]: ${bytes} > ${upper}`,
      );
      if (t2 - t1 >= 1000) {
        const lower = (R * (t2 - t1)) / 1000 - 4096;
        ok(
          bytes >= lower - 1e-6,
          `throughput too low on (${t1}, ${t2}]: ${bytes} < ${lower}`,
        );
      }
    }
  }

  // The late joiner received a fair share, not a catch-up flood:
  // in its first second it cannot exceed one burst plus its fair share.
  const cFirstSecond = bytesInWindow(
    events.filter((e) => e.stream === "C"),
    5000,
    6000,
  );
  ok(
    cFirstSecond <= (R / 3) * 1 + 4096,
    `late joiner caught up: ${cFirstSecond} bytes in first second`,
  );
});

test("hung next/write do not block peers; cancel kills late completions", async () => {
  const clock = new VirtualClock();
  const shaper = createShaper(clock, { p1: 1000, p2: 2000 });

  // H1: second next() hangs.
  const h1Next = deferred<IteratorResult<Uint8Array>>();
  let h1NextCalls = 0;
  const h1Source: ByteSource = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          h1NextCalls++;
          if (h1NextCalls === 1) {
            return Promise.resolve({ done: false, value: new Uint8Array(10) });
          }
          return h1Next.promise;
        },
      };
    },
  };
  const h1Writes: number[] = [];
  const h1 = shaper.start("p1", h1Source, (c) => {
    h1Writes.push(c.length);
    return Promise.resolve();
  });
  const h1Done = watch(h1);

  // H2: first write() hangs.
  const h2Write = deferred<unknown>();
  let h2WriteCalls = 0;
  let h2NextCalls = 0;
  const h2Source: ByteSource = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        h2NextCalls++;
        yield new Uint8Array(100);
      }
    },
  };
  const h2 = shaper.start("p2", h2Source, () => {
    h2WriteCalls++;
    return h2Write.promise as Promise<unknown>;
  });
  const h2Done = watch(h2);

  // Healthy peers in both profiles.
  const aEvents: WriteEvent[] = [];
  const a = shaper.start(
    "p1",
    infiniteSource(100),
    (c) => {
      aEvents.push({ stream: "A", t: clock.now(), n: c.length });
      return Promise.resolve();
    },
  );
  const aDone = watch(a);
  const bEvents: WriteEvent[] = [];
  const b = shaper.start(
    "p2",
    infiniteSource(100),
    (c) => {
      bEvents.push({ stream: "B", t: clock.now(), n: c.length });
      return Promise.resolve();
    },
  );
  const bDone = watch(b);

  await clock.advance(5000);

  // Hung transfers never got extra pulls; healthy peers kept moving.
  equal(h1NextCalls, 2, "H1 must not be polled while its next() is pending");
  equal(h2WriteCalls, 1, "H2 must not get a second write while one is pending");
  equal(h2NextCalls, 1, "H2 must not pull a new chunk before finishing one");
  const aBytes = aEvents.reduce((s, e) => s + e.n, 0);
  const bBytes = bEvents.reduce((s, e) => s + e.n, 0);
  ok(aBytes >= 4000, `same-profile peer stalled by hung streams: ${aBytes}`);
  ok(bBytes >= 5900, `other-profile peer stalled: ${bBytes}`);

  // Cancel the hung transfers, then release their promises late.
  h1.cancel();
  h2.cancel();
  const h1NextAfter = h1NextCalls;
  const h2WriteAfter = h2WriteCalls;
  const h2NextAfter = h2NextCalls;
  h1Next.resolve({ done: false, value: new Uint8Array(10) });
  h2Write.resolve(undefined);
  await clock.flush();

  equal(h1NextCalls, h1NextAfter, "cancelled H1 pulled again after cancel");
  equal(h2WriteCalls, h2WriteAfter, "cancelled H2 wrote after cancel");
  equal(h2NextCalls, h2NextAfter, "cancelled H2 pulled after cancel");
  equal(h1Writes.length, 1, "H1 wrote exactly its first chunk");
  await expectCancelled(h1Done);
  await expectCancelled(h2Done);

  // Healthy peers still progress afterwards.
  const aBytesBefore = aBytes;
  await clock.advance(1000);
  ok(
    aEvents.reduce((s, e) => s + e.n, 0) > aBytesBefore,
    "peer stopped progressing after cancels",
  );

  a.cancel();
  b.cancel();
  await expectCancelled(aDone);
  await expectCancelled(bDone);
  equal(clock.pendingTimers, 0, "no leftover timers after all cancels");
});

test("clock jump does not unleash a catch-up flood", async () => {
  const clock = new VirtualClock();
  const R = 1000;
  const shaper = createShaper(clock, { p: R });
  const events: WriteEvent[] = [];
  const h = shaper.start("p", infiniteSource(65536), (c) => {
    events.push({ stream: "S", t: clock.now(), n: c.length });
    return Promise.resolve();
  });
  const done = watch(h);

  await clock.advance(5000); // drain initial burst + steady state
  const drained = events.reduce((s, e) => s + e.n, 0);
  ok(drained >= 8000 && drained <= 4096 + 5000 + 1, `drained=${drained}`);

  clock.jump(3_600_000); // one hour passes at once
  const mark = clock.now();
  const before = events.reduce((s, e) => s + e.n, 0);

  // Fires the timer that was pending during the jump, then advances 2s.
  await clock.advance(2000);
  const afterJump = events.reduce((s, e) => s + e.n, 0) - before;
  const upper = (R * 2000) / 1000 + 4096;
  ok(
    afterJump <= upper + 1e-6,
    `jump released ${afterJump} bytes (> ${upper}); window start=${mark}`,
  );
  ok(afterJump >= 4096, "available burst must still be delivered");

  h.cancel();
  await expectCancelled(done);
  equal(clock.pendingTimers, 0, "no leftover timers after cancel");
});

test("lossless in-order delivery, done resolves, write cap and backpressure", async () => {
  const clock = new VirtualClock();
  const shaper = createShaper(clock, { p: 65536 });
  const part1 = new Uint8Array(5000);
  const part2 = new Uint8Array(3000);
  for (let i = 0; i < part1.length; i++) part1[i] = i % 251;
  for (let i = 0; i < part2.length; i++) part2[i] = (i * 7) % 253;

  async function* source(): AsyncGenerator<Uint8Array> {
    yield part1;
    yield part2;
  }

  const written: number[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let maxWrite = 0;
  const h = shaper.start("p", source(), async (c) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    maxWrite = Math.max(maxWrite, c.length);
    for (const byte of c) written.push(byte);
    await Promise.resolve();
    await Promise.resolve();
    inflight--;
  });
  const done = watch(h);

  await clock.advance(2000);
  const result = await done;
  deepEqual(result, { status: "resolved" });
  equal(written.length, 8000, "all bytes delivered");
  deepEqual(
    Uint8Array.from(written),
    Uint8Array.from([...part1, ...part2]),
    "bytes delivered losslessly and in order",
  );
  ok(maxWrite <= MAX_WRITE_BYTES, `write too large: ${maxWrite}`);
  equal(maxInflight, 1, "at most one outstanding write per transfer");
  equal(clock.pendingTimers, 0, "no spinning timer after completion");
});

test("validation", async () => {
  const clock = new VirtualClock();
  const shaper = createShaper(clock, { p: 1000 });
  let threw = false;
  try {
    shaper.start("nope", infiniteSource(1), () => Promise.resolve());
  } catch {
    threw = true;
  }
  ok(threw, "unknown profileId must throw");
  threw = false;
  try {
    createShaper(clock, { bad: 0 });
  } catch {
    threw = true;
  }
  ok(threw, "non-positive rate must throw");
});
