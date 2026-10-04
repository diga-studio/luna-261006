import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { TelemetryBuffer } from "../src/index";
import type { ArchivedRecord } from "../src/index";
import { readAll, tempDir } from "./helpers";

const CHILD_PATH = path.join(__dirname, "crash-child.js");
const BASE = 5_000_000;

function runCrashedChild(
  dir: string,
  scenario: "partial" | "flushed",
  tag: string,
  count: number,
  baseNow: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CHILD_PATH, dir, scenario, tag, String(count), String(baseNow)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not reach pause point; stdout=${stdout} stderr=${stderr}`));
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("READY") && !killed) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (!killed) {
        reject(new Error(`child exited before pause point: code=${code} signal=${signal} stdout=${stdout}`));
        return;
      }
      if (signal !== "SIGKILL") {
        reject(new Error(`expected SIGKILL, got code=${code} signal=${signal}`));
        return;
      }
      resolve();
    });
  });
}

function drainFrom(buf: TelemetryBuffer, cursor: string): ArchivedRecord[] {
  const out: ArchivedRecord[] = [];
  let current: string | undefined = cursor;
  for (;;) {
    const page = buf.read(current, 4);
    out.push(...page.records);
    if (page.records.length === 0 || page.nextCursor === current) {
      break;
    }
    current = page.nextCursor;
  }
  return out;
}

function assertUniqueReceipts(records: ArchivedRecord[]): void {
  const seen = new Set<number>();
  for (const record of records) {
    assert.ok(!seen.has(record.receipt), `duplicate receipt ${record.receipt} in archive`);
    seen.add(record.receipt);
  }
}

function assertPrefix(stable: ArchivedRecord[], current: ArchivedRecord[]): void {
  assert.ok(current.length >= stable.length, "archive shrank after recovery");
  for (let i = 0; i < stable.length; i += 1) {
    assert.equal(current[i].receipt, stable[i].receipt, `receipt changed at position ${i}`);
    assert.equal(current[i].deviceId, stable[i].deviceId);
    assert.equal(current[i].sampleAt, stable[i].sampleAt);
    assert.deepEqual(current[i].payload, stable[i].payload, `payload changed at position ${i}`);
  }
}

test("archive survives SIGKILL at partial write and at flushed-but-uncommitted points", { timeout: 120_000 }, async () => {
  const dir = tempDir("tb-crash-");

  // Phase 1: normal in-process operation, keep a mid-archive cursor.
  let buf = new TelemetryBuffer({ dir });
  for (let i = 0; i < 5; i += 1) {
    buf.ingest(
      { deviceId: `main-${i}`, sampleAt: BASE + i, payload: Buffer.from(`main-payload-${i}`) },
      BASE + i,
    );
  }
  buf.advance(BASE + 120_000);
  const phase1 = readAll(buf);
  assert.equal(phase1.length, 5);
  const midPage = buf.read(undefined, 3);
  const midCursor = midPage.nextCursor;
  assert.equal(midPage.records.length, 3);
  buf.close();

  let stable = phase1;
  let expected = phase1.map((r) => ({ deviceId: r.deviceId, payload: r.payload.toString() }));

  // Phases 2..4: a child ingests more events and is SIGKILLed mid-advance at
  // each pause point; the parent then reopens and replays with the same now.
  const phases: Array<{ scenario: "partial" | "flushed"; tag: string; count: number; baseNow: number }> = [
    { scenario: "partial", tag: "p2", count: 10, baseNow: BASE + 200_000 },
    { scenario: "flushed", tag: "p3", count: 10, baseNow: BASE + 400_000 },
    { scenario: "partial", tag: "p4", count: 6, baseNow: BASE + 600_000 },
  ];

  for (const phase of phases) {
    for (let i = 0; i < phase.count; i += 1) {
      expected.push({
        deviceId: `child-${phase.tag}-${i}`,
        payload: `payload-${phase.tag}-${i}`,
      });
    }
    await runCrashedChild(dir, phase.scenario, phase.tag, phase.count, phase.baseNow);

    buf = new TelemetryBuffer({ dir });
    // Replaying advance with the same now must complete the interrupted work.
    buf.advance(phase.baseNow + 120_000);
    const all = readAll(buf);
    assert.equal(all.length, expected.length, `lost records after ${phase.scenario} crash`);
    assertUniqueReceipts(all);
    assertPrefix(stable, all);
    assert.deepEqual(
      all.map((r) => ({ deviceId: r.deviceId, payload: r.payload.toString() })),
      expected,
    );

    // The cursor captured in phase 1 must still be valid and continue
    // exactly where it stopped, with no duplicates or gaps.
    const rest = drainFrom(buf, midCursor);
    assert.equal(rest.length, all.length - 3);
    assert.deepEqual(
      rest.map((r) => r.receipt),
      all.slice(3).map((r) => r.receipt),
    );

    stable = all;
    buf.close();
  }

  // Final reopen: everything still readable, still exactly once.
  buf = new TelemetryBuffer({ dir });
  const finalAll = readAll(buf);
  assert.equal(finalAll.length, expected.length);
  assertUniqueReceipts(finalAll);
  assertPrefix(stable, finalAll);
  buf.close();
});
