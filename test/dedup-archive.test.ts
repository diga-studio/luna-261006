import assert from "node:assert/strict";
import test from "node:test";
import { TelemetryBuffer, LateEventError } from "../src/index";
import { payloadOf, readAll, tempDir } from "./helpers";

const T0 = 1_000_000;

test("same key resend within 30s window returns original receipt and first payload", () => {
  const dir = tempDir("tb-dedup-");
  const buf = new TelemetryBuffer({ dir });
  try {
    const first = buf.ingest({ deviceId: "dev-a", sampleAt: T0, payload: payloadOf("first") }, T0 + 100);
    assert.equal(first.duplicate, false);

    const beforeBoundary = buf.ingest(
      { deviceId: "dev-a", sampleAt: T0, payload: payloadOf("second") },
      T0 + 100 + 29_999,
    );
    assert.equal(beforeBoundary.duplicate, true);
    assert.equal(beforeBoundary.receipt, first.receipt);

    // Exactly 30s after first acceptance: window expired, new receipt.
    const atBoundary = buf.ingest(
      { deviceId: "dev-a", sampleAt: T0, payload: payloadOf("third") },
      T0 + 100 + 30_000,
    );
    assert.equal(atBoundary.duplicate, false);
    assert.ok(atBoundary.receipt > first.receipt);

    buf.advance(T0 + 61_000);
    const records = readAll(buf);
    assert.equal(records.length, 2);
    assert.equal(records[0].receipt, first.receipt);
    assert.deepEqual(records[0].payload, payloadOf("first"));
    assert.equal(records[1].receipt, atBoundary.receipt);
    assert.deepEqual(records[1].payload, payloadOf("third"));
  } finally {
    buf.close();
  }
});

test("duplicate resend does not extend the dedup window", () => {
  const dir = tempDir("tb-dedup-window-");
  const buf = new TelemetryBuffer({ dir });
  try {
    const first = buf.ingest({ deviceId: "dev-b", sampleAt: T0, payload: payloadOf("a") }, T0);
    // Resend at +29s: still duplicate.
    const dup = buf.ingest({ deviceId: "dev-b", sampleAt: T0, payload: payloadOf("b") }, T0 + 29_000);
    assert.equal(dup.duplicate, true);
    // Window measured from first acceptance, so +31s from first is expired
    // even though the resend happened only 2s ago.
    const after = buf.ingest({ deviceId: "dev-b", sampleAt: T0, payload: payloadOf("c") }, T0 + 31_000);
    assert.equal(after.duplicate, false);
    assert.ok(after.receipt > first.receipt);
  } finally {
    buf.close();
  }
});

test("60s archive boundary: sampleAt <= now - 60000 is archived, and late ingest rejected", () => {
  const dir = tempDir("tb-boundary-");
  const buf = new TelemetryBuffer({ dir });
  try {
    const accepted = buf.ingest({ deviceId: "dev-c", sampleAt: T0, payload: payloadOf("edge") }, T0);

    buf.advance(T0 + 59_999);
    assert.equal(readAll(buf).length, 0, "not yet due one ms before the boundary");

    buf.advance(T0 + 60_000);
    const records = readAll(buf);
    assert.equal(records.length, 1, "sampleAt == now - 60000 must be archived");
    assert.equal(records[0].receipt, accepted.receipt);

    // Ingest with sampleAt exactly now - 60000 is late and rejected.
    assert.throws(
      () => buf.ingest({ deviceId: "dev-d", sampleAt: T0, payload: payloadOf("late") }, T0 + 60_000),
      (err: unknown) => err instanceof LateEventError,
    );
    // One ms newer is still acceptable.
    const ok = buf.ingest({ deviceId: "dev-d", sampleAt: T0 + 1, payload: payloadOf("ok") }, T0 + 60_000);
    assert.equal(ok.duplicate, false);
  } finally {
    buf.close();
  }
});

test("archive order: sampleAt ascending, ties broken by receipt ascending", () => {
  const dir = tempDir("tb-order-");
  const buf = new TelemetryBuffer({ dir });
  try {
    // Ingest out of sampleAt order; three share the same sampleAt.
    const r1 = buf.ingest({ deviceId: "d1", sampleAt: T0 + 5000, payload: payloadOf("p1") }, T0 + 5000);
    const r2 = buf.ingest({ deviceId: "d2", sampleAt: T0 + 1000, payload: payloadOf("p2") }, T0 + 5000);
    const r3 = buf.ingest({ deviceId: "d3", sampleAt: T0 + 1000, payload: payloadOf("p3") }, T0 + 5000);
    const r4 = buf.ingest({ deviceId: "d4", sampleAt: T0 + 1000, payload: payloadOf("p4") }, T0 + 5000);
    const r5 = buf.ingest({ deviceId: "d5", sampleAt: T0 + 3000, payload: payloadOf("p5") }, T0 + 5000);

    buf.advance(T0 + 70_000);
    const records = readAll(buf, 2);
    assert.deepEqual(
      records.map((r) => r.receipt),
      [r2.receipt, r3.receipt, r4.receipt, r5.receipt, r1.receipt],
    );
    assert.deepEqual(
      records.map((r) => r.sampleAt),
      [T0 + 1000, T0 + 1000, T0 + 1000, T0 + 3000, T0 + 5000],
    );
    assert.deepEqual(
      records.map((r) => r.payload.toString()),
      ["p2", "p3", "p4", "p5", "p1"],
    );
  } finally {
    buf.close();
  }
});
