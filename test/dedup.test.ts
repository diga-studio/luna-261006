import assert from "node:assert/strict";
import test from "node:test";
import { TelemetryBuffer } from "../src/index.ts";
import type { ArchivedRecord } from "../src/index.ts";
import { payloadOf, tempDir } from "../testlib/helpers.ts";

function readAll(tb: TelemetryBuffer): ArchivedRecord[] {
  const all: ArchivedRecord[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = tb.read(cursor, 2);
    all.push(...page.records);
    if (page.nextCursor === null) return all;
    cursor = page.nextCursor;
  }
}

test("dedup window: resend before and after the 30s boundary keeps first payload", () => {
  const dir = tempDir("tb-dedup-");
  const tb = new TelemetryBuffer({ dir });
  const t0 = 1_000_000;

  const first = tb.ingest({ deviceId: "dev-1", sampleAt: t0 - 1000, payload: payloadOf("first") }, t0);
  assert.deepEqual(first, { status: "accepted", receipt: 1 });

  const beforeBoundary = tb.ingest(
    { deviceId: "dev-1", sampleAt: t0 - 1000, payload: payloadOf("second") },
    t0 + 29_999,
  );
  assert.deepEqual(beforeBoundary, { status: "duplicate", receipt: 1 });

  const atBoundary = tb.ingest(
    { deviceId: "dev-1", sampleAt: t0 - 1000, payload: payloadOf("third") },
    t0 + 30_000,
  );
  assert.deepEqual(atBoundary, { status: "accepted", receipt: 2 });

  const afterBoundary = tb.ingest(
    { deviceId: "dev-1", sampleAt: t0 - 1000, payload: payloadOf("fourth") },
    t0 + 30_001,
  );
  assert.deepEqual(afterBoundary, { status: "duplicate", receipt: 2 });

  const archived = tb.advance(t0 + 30_001 + 60_000);
  assert.equal(archived, 2);

  const records = readAll(tb).filter((r) => r.deviceId === "dev-1");
  assert.equal(records.length, 2);
  assert.equal(records[0].receipt, 1);
  assert.equal(Buffer.from(records[0].payload).toString(), "first");
  assert.equal(records[1].receipt, 2);
  assert.equal(Buffer.from(records[1].payload).toString(), "third");
  tb.close();
});

test("late boundary: sampleAt <= now - 60000 rejected, checked after dedup", () => {
  const dir = tempDir("tb-late-");
  const tb = new TelemetryBuffer({ dir });
  const now = 10_000_000;

  const atThreshold = tb.ingest(
    { deviceId: "dev-2", sampleAt: now - 60_000, payload: payloadOf("a") },
    now,
  );
  assert.deepEqual(atThreshold, { status: "rejected", reason: "late" });

  const inside = tb.ingest(
    { deviceId: "dev-2", sampleAt: now - 60_000 + 1, payload: payloadOf("b") },
    now,
  );
  assert.deepEqual(inside, { status: "accepted", receipt: 1 });

  const lateButKnown = tb.ingest(
    { deviceId: "dev-2", sampleAt: now - 60_000 + 1, payload: payloadOf("c") },
    now + 1,
  );
  assert.deepEqual(lateButKnown, { status: "duplicate", receipt: 1 });
  tb.close();
});

test("archive order: sampleAt ascending, receipt ascending on ties", () => {
  const dir = tempDir("tb-order-");
  const tb = new TelemetryBuffer({ dir });
  const now = 5_000_000;

  tb.ingest({ deviceId: "dev-b", sampleAt: now - 1000, payload: payloadOf("b1") }, now);
  tb.ingest({ deviceId: "dev-a", sampleAt: now - 5000, payload: payloadOf("a1") }, now);
  tb.ingest({ deviceId: "dev-c", sampleAt: now - 1000, payload: payloadOf("c1") }, now);
  tb.ingest({ deviceId: "dev-b", sampleAt: now - 3000, payload: payloadOf("b2") }, now);

  assert.equal(tb.advance(now + 60_000), 4);
  const records = readAll(tb);
  assert.deepEqual(
    records.map((r) => [r.receipt, r.sampleAt]),
    [
      [2, now - 5000],
      [4, now - 3000],
      [1, now - 1000],
      [3, now - 1000],
    ],
  );
  tb.close();
});

test("payload up to 4 KiB round-trips byte-exact; oversize rejected", () => {
  const dir = tempDir("tb-payload-");
  const tb = new TelemetryBuffer({ dir });
  const now = 5_000_000;
  const big = Buffer.alloc(4096);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;

  const res = tb.ingest({ deviceId: "dev-3", sampleAt: now - 1, payload: big }, now);
  assert.equal(res.status, "accepted");
  assert.throws(() =>
    tb.ingest({ deviceId: "dev-3", sampleAt: now - 1, payload: Buffer.alloc(4097) }, now),
  );

  tb.advance(now + 60_000);
  const records = readAll(tb);
  assert.equal(records.length, 1);
  assert.deepEqual(Buffer.from(records[0].payload), big);
  tb.close();
});
