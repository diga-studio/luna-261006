import { test } from "node:test";
import assert from "node:assert/strict";
import { createDetector } from "../../src/index";
import type { HitSummary, Rule, TelemetryEvent } from "../../src/types";

function binom(n: number, k: number): bigint {
  if (n < k) return 0n;
  let result = 1n;
  for (let i = 0; i < k; i++) {
    result = (result * BigInt(n - i)) / BigInt(i + 1);
  }
  return result;
}

function heapMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

// Sustained sliding window: one agent, one event per millisecond, 8 identical
// stages, W = 10000. The exact count for the i-th event (0-based) is
// C(min(i, 10000), 7), which exceeds Number.MAX_SAFE_INTEGER in steady state.
test("200k-event sliding window with exact combinatorial counts", { timeout: 300_000 }, () => {
  const TOTAL = 200_000;
  const W = 10_000;
  const K = 8;
  const identical = { eventType: "proc", conditions: { kind: "exec" } };
  const rules: Rule[] = [
    {
      ruleId: "chain8",
      windowMs: W,
      stages: Array.from({ length: K }, () => ({ ...identical, conditions: { ...identical.conditions } })),
    },
  ];

  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
  const heapStart = heapMB();
  let heapPeak = heapStart;

  const detector = createDetector(rules);
  const t0 = process.hrtime.bigint();

  let summaries = 0;
  let exceededSafeInteger = false;
  const BATCH = 1000;
  for (let base = 0; base < TOTAL; base += BATCH) {
    const events: TelemetryEvent[] = [];
    for (let i = base; i < base + BATCH; i++) {
      events.push({
        eventId: `ev${i}`,
        agentId: "agent-1",
        ts: i,
        eventType: "proc",
        payload: { kind: "exec" },
      });
    }
    const hits: HitSummary[] = detector.ingest(events);
    // Verify every summary: event i must report C(min(i, W), K-1), nothing else.
    let expectedInBatch = 0;
    for (let i = base; i < base + BATCH; i++) {
      if (i >= K - 1) expectedInBatch++;
    }
    assert.equal(hits.length, expectedInBatch, `batch starting at ${base}`);
    for (const hit of hits) {
      const i = Number(hit.eventId.slice(2));
      const expected = binom(Math.min(i, W), K - 1).toString(10);
      assert.equal(hit.ruleId, "chain8");
      assert.equal(hit.agentId, "agent-1");
      assert.equal(hit.count, expected, `count for event ${i}`);
      if (BigInt(hit.count) > BigInt(Number.MAX_SAFE_INTEGER)) {
        exceededSafeInteger = true;
      }
      summaries++;
    }
    // Interleave legal time advancement with the event stream.
    detector.advanceTo(base + BATCH - 1);
    const now = heapMB();
    if (now > heapPeak) heapPeak = now;
    if (base % 50_000 === 0) {
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(
        `  progress ${base + BATCH}/${TOTAL}  elapsed=${elapsedMs.toFixed(0)}ms  heap=${now.toFixed(1)}MB`,
      );
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Push time far beyond every window: all per-event and per-agent state
  // must be discarded.
  detector.advanceTo(TOTAL + 10 * W);
  if (gc) gc();
  const heapAfterExpiry = heapMB();

  // A stray old event must not pair with anything after full expiry.
  const late = detector.ingest([
    {
      eventId: "late0",
      agentId: "agent-1",
      ts: TOTAL + 10 * W,
      eventType: "proc",
      payload: { kind: "exec" },
    },
  ]);
  assert.equal(late.length, 0);

  assert.equal(summaries, TOTAL - (K - 1));
  assert.ok(exceededSafeInteger, "expected counts beyond Number.MAX_SAFE_INTEGER");
  // Steady-state count sanity: C(10000, 7) is astronomically larger than 2^53.
  assert.ok(binom(W, K - 1) > 2n ** 53n);

  console.log(
    `  done: ${TOTAL} events in ${elapsedMs.toFixed(0)}ms ` +
      `(${(TOTAL / (elapsedMs / 1000)).toFixed(0)} ev/s), ` +
      `heap start=${heapStart.toFixed(1)}MB peak=${heapPeak.toFixed(1)}MB ` +
      `after-expiry=${heapAfterExpiry.toFixed(1)}MB`,
  );

  // Resident state must not grow with cumulative input: after advancing past
  // all windows, heap usage returns close to where it started.
  assert.ok(
    heapAfterExpiry - heapStart < 64,
    `heap grew by ${(heapAfterExpiry - heapStart).toFixed(1)}MB after full expiry`,
  );
});
