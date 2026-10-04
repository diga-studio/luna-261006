import assert from "node:assert/strict";
import test from "node:test";
import { TelemetryBuffer, LateEventError } from "../src/index";
import { readAll, tempDir } from "./helpers";

const T0 = 10_000_000;
const COUNT = 2000; // far beyond the 256-payload in-memory batch limit

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function expectedPayload(i: number): Buffer {
  const buf = Buffer.alloc(100);
  for (let k = 0; k < buf.length; k += 1) {
    buf[k] = (i * 31 + k * 7) & 0xff;
  }
  return buf;
}

test("large out-of-order backlog survives restart and far-future advance", () => {
  const dir = tempDir("tb-backlog-");
  const rand = lcg(42);

  // Ingest out of sampleAt order across many devices.
  const sampleAts: number[] = [];
  let buf = new TelemetryBuffer({ dir });
  const ingestNow = T0 + 59_000;
  for (let i = 0; i < COUNT; i += 1) {
    const sampleAt = T0 + Math.floor(rand() / 0xffffffff * 59_000);
    sampleAts.push(sampleAt);
    const result = buf.ingest(
      { deviceId: `dev-${i}`, sampleAt, payload: expectedPayload(i) },
      ingestNow,
    );
    assert.equal(result.receipt, i + 1, "receipts are strictly increasing from 1");
  }
  buf.close();

  // Reopen and push now far into the future. Records accepted earlier must be
  // archived by replay, never re-checked as late arrivals.
  buf = new TelemetryBuffer({ dir });
  buf.advance(T0 + 10_000_000);

  // Late rejection still applies to genuinely new ingest attempts.
  assert.throws(
    () => buf.ingest({ deviceId: "fresh", sampleAt: T0, payload: Buffer.from("x") }, T0 + 10_000_000),
    (err: unknown) => err instanceof LateEventError,
  );

  const records = readAll(buf, 50);
  assert.equal(records.length, COUNT, "every accepted receipt archived exactly once");

  const seen = new Set<number>();
  let prevSampleAt = -1;
  let prevReceipt = -1;
  for (const record of records) {
    assert.ok(!seen.has(record.receipt), `duplicate receipt ${record.receipt}`);
    seen.add(record.receipt);
    assert.ok(
      record.sampleAt > prevSampleAt ||
        (record.sampleAt === prevSampleAt && record.receipt > prevReceipt),
      `archive order violated at receipt ${record.receipt}`,
    );
    prevSampleAt = record.sampleAt;
    prevReceipt = record.receipt;
    const i = Number(record.deviceId.slice(4));
    assert.deepEqual(record.payload, expectedPayload(i), `payload corrupted for ${record.deviceId}`);
    assert.equal(record.sampleAt, sampleAts[i]);
  }
  for (let i = 1; i <= COUNT; i += 1) {
    assert.ok(seen.has(i), `receipt ${i} missing from archive`);
  }
  buf.close();

  // Reopen once more: archive is fully readable and stable.
  buf = new TelemetryBuffer({ dir });
  const again = readAll(buf, 333);
  assert.equal(again.length, COUNT);
  assert.deepEqual(
    again.map((r) => r.receipt),
    records.map((r) => r.receipt),
  );
  buf.close();
});
