import assert from "node:assert/strict";
import test from "node:test";
import { TelemetryBuffer } from "../src/index.ts";
import type { ArchivedRecord } from "../src/index.ts";
import { tempDir } from "../testlib/helpers.ts";

test("out-of-order backlog beyond memory batch survives restart and far-future advance", () => {
  const dir = tempDir("tb-backlog-");
  const now = 100_000_000;
  const total = 1000;

  const shuffled: number[] = Array.from({ length: total }, (_, i) => i);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = (i * 7919) % (i + 1);
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }

  let tb = new TelemetryBuffer({ dir, batchSize: 128 });
  for (const i of shuffled) {
    const payload = Buffer.alloc(4096);
    payload.writeUInt32LE(i, 0);
    payload.fill(0xa5, 4);
    const res = tb.ingest(
      { deviceId: `dev-${i % 16}`, sampleAt: now - 60_000 + 1 + i, payload },
      now,
    );
    assert.equal(res.status, "accepted");
    if (res.status === "accepted") assert.ok(res.receipt >= 1 && res.receipt <= total);
  }
  tb.close();

  tb = new TelemetryBuffer({ dir });
  const farFuture = now + 10_000_000;
  const archived = tb.advance(farFuture);
  assert.equal(archived, total);
  assert.equal(tb.advance(farFuture), 0);

  const lateNew = tb.ingest(
    { deviceId: "dev-new", sampleAt: now - 1000, payload: Buffer.from("late") },
    farFuture,
  );
  assert.deepEqual(lateNew, { status: "rejected", reason: "late" });

  const all: ArchivedRecord[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = tb.read(cursor, 77);
    all.push(...page.records);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  assert.equal(all.length, total);

  const receipts = all.map((r) => r.receipt);
  assert.equal(new Set(receipts).size, total);
  assert.deepEqual(
    [...receipts].sort((a, b) => a - b),
    Array.from({ length: total }, (_, i) => i + 1),
  );

  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i].sampleAt >= all[i - 1].sampleAt, "sampleAt non-decreasing");
  }
  for (const record of all) {
    const payload = Buffer.from(record.payload);
    assert.equal(payload.length, 4096);
    const index = payload.readUInt32LE(0);
    assert.ok(payload.subarray(4).every((b) => b === 0xa5));
    assert.equal(record.sampleAt, now - 60_000 + 1 + index);
  }
  tb.close();

  tb = new TelemetryBuffer({ dir });
  const afterReopen = tb.read(null, 10);
  assert.equal(afterReopen.records.length, 10);
  assert.equal(afterReopen.records[0].receipt, all[0].receipt);
  tb.close();
});
