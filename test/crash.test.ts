import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { TelemetryBuffer } from "../src/index.ts";
import type { ArchivedRecord } from "../src/index.ts";
import { payloadOf, tempDir } from "../testlib/helpers.ts";

const CHILD_SCRIPT = path.join(import.meta.dirname, "..", "testlib", "crash-child.ts");

function runChild(dir: string, mode: string, count: number, now: number, after: number): void {
  const result = spawnSync(process.execPath, [CHILD_SCRIPT], {
    env: {
      ...process.env,
      CRASH_DIR: dir,
      CRASH_MODE: mode,
      CRASH_COUNT: String(count),
      CRASH_NOW: String(now),
      CRASH_AFTER: String(after),
    },
    encoding: "utf8",
  });
  assert.equal(
    result.signal,
    "SIGKILL",
    `child must be hard-killed, got signal=${result.signal} status=${result.status} stderr=${result.stderr}`,
  );
}

function collectFrom(tb: TelemetryBuffer, cursor: string | null): ArchivedRecord[] {
  const all: ArchivedRecord[] = [];
  let next = cursor;
  do {
    const page = tb.read(next, 4);
    all.push(...page.records);
    next = page.nextCursor;
  } while (next !== null);
  return all;
}

function verifyFullArchive(
  tb: TelemetryBuffer,
  expectedTotal: number,
  parentPayloads: string[],
  childCount: number,
): void {
  const all = collectFrom(tb, null);
  assert.equal(all.length, expectedTotal);
  const receipts = all.map((r) => r.receipt);
  assert.deepEqual([...receipts].sort((a, b) => a - b), Array.from({ length: expectedTotal }, (_, i) => i + 1));
  assert.equal(new Set(receipts).size, expectedTotal, "no duplicate receipts");
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i].sampleAt >= all[i - 1].sampleAt, "sampleAt non-decreasing");
  }
  for (let i = 0; i < parentPayloads.length; i++) {
    assert.equal(Buffer.from(all[i].payload).toString(), parentPayloads[i]);
  }
  for (let i = 0; i < childCount; i++) {
    assert.equal(
      Buffer.from(all[parentPayloads.length + i].payload).toString(),
      `payload-${i}`,
    );
  }
}

function crashRecoveryScenario(mode: string): void {
  const dir = tempDir(`tb-crash-${mode}-`);
  const now1 = 2_000_000;
  const parentPayloads = ["parent-0", "parent-1", "parent-2", "parent-3", "parent-4"];

  let tb = new TelemetryBuffer({ dir });
  for (let i = 0; i < parentPayloads.length; i++) {
    const res = tb.ingest(
      { deviceId: `dev-p${i}`, sampleAt: now1 - 1000 + i, payload: payloadOf(parentPayloads[i]) },
      now1,
    );
    assert.equal(res.status, "accepted");
  }
  assert.equal(tb.advance(now1 + 60_000), parentPayloads.length);
  const firstPage = tb.read(null, 3);
  assert.equal(firstPage.records.length, 3);
  const savedCursor = firstPage.nextCursor;
  assert.notEqual(savedCursor, null);
  tb.close();

  const now2 = now1 + 60_000;
  const childCount = 10;
  runChild(dir, mode, childCount, now2, 3);

  tb = new TelemetryBuffer({ dir });
  tb.advance(now2 + 60_000);

  const continued = collectFrom(tb, savedCursor);
  const prefix = firstPage.records.map((r) => r.receipt);
  const continuedReceipts = continued.map((r) => r.receipt);
  assert.deepEqual(prefix, [1, 2, 3]);
  assert.deepEqual(continuedReceipts, Array.from({ length: 12 }, (_, i) => i + 4));

  verifyFullArchive(tb, parentPayloads.length + childCount, parentPayloads, childCount);
  tb.close();

  for (let round = 0; round < 3; round++) {
    tb = new TelemetryBuffer({ dir });
    tb.advance(now2 + 60_000);
    verifyFullArchive(tb, parentPayloads.length + childCount, parentPayloads, childCount);
    const again = collectFrom(tb, savedCursor);
    assert.deepEqual(again.map((r) => r.receipt), continuedReceipts);
    tb.close();
  }
}

test("crash after partial record write: tail truncated, remaining records completed", () => {
  crashRecoveryScenario("partial");
});

test("crash after full record write before state commit: replay without re-admission", () => {
  crashRecoveryScenario("uncommitted");
});
