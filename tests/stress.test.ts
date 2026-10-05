import test from "node:test";
import assert from "node:assert/strict";
import { createDetector } from "../src/detector.ts";
import type { HitSummary, TelemetryEvent } from "../src/types.ts";

function binom(n: number, k: number): bigint {
  if (n < k) return 0n;
  let result = 1n;
  for (let i = 1; i <= k; i++) {
    result = (result * BigInt(n - k + i)) / BigInt(i);
  }
  return result;
}

test("200k-event sliding window, 8 identical stages, exact binomial counts", () => {
  const N = 200_000;
  const W = 10_000;
  const K = 8;
  const BATCH = 4096;

  const detector = createDetector([
    {
      ruleId: "stress",
      windowMs: W,
      stages: Array.from({ length: K }, () => ({ eventType: "EV" })),
    },
  ]);

  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const memBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();

  const hits: HitSummary[] = [];
  let batch: TelemetryEvent[] = [];
  for (let n = 0; n < N; n++) {
    batch.push({ eventId: `ev-${n}`, agentId: "agent-1", ts: n, eventType: "EV" });
    if (batch.length === BATCH || n === N - 1) {
      hits.push(...detector.ingest(batch));
      batch = [];
      // Legal no-op time advance; also exercises advanceTo on a hot detector.
      detector.advanceTo(n);
    }
  }

  const tMid = performance.now();
  gc?.();
  const memAfterStream = process.memoryUsage().heapUsed;

  // Every ending event n >= K-1 emits exactly C(min(n, W), K-1) chains.
  assert.equal(hits.length, N - (K - 1));
  let sawBeyondSafeInteger = false;
  for (let n = K - 1; n < N; n++) {
    const hit = hits[n - (K - 1)];
    const expected = binom(Math.min(n, W), K - 1);
    assert.equal(hit.ruleId, "stress");
    assert.equal(hit.agentId, "agent-1");
    assert.equal(hit.eventId, `ev-${n}`);
    assert.equal(hit.count, expected.toString(), `count mismatch at n=${n}`);
    if (expected > BigInt(Number.MAX_SAFE_INTEGER)) sawBeyondSafeInteger = true;
  }
  assert.ok(sawBeyondSafeInteger, "expected counts beyond Number.MAX_SAFE_INTEGER");

  // Cross-check batch invariance on a prefix: one-by-one ingest must agree.
  const prefixN = 5000;
  const drip = createDetector([
    {
      ruleId: "stress",
      windowMs: W,
      stages: Array.from({ length: K }, () => ({ eventType: "EV" })),
    },
  ]);
  for (let n = 0; n < prefixN; n++) {
    const got = drip.ingest([
      { eventId: `ev-${n}`, agentId: "agent-1", ts: n, eventType: "EV" },
    ]);
    const expected = n >= K - 1 ? [hits[n - (K - 1)]] : [];
    assert.deepEqual(got, expected, `prefix mismatch at n=${n}`);
  }

  // Advance far beyond every window: all state must be discarded.
  detector.advanceTo(Number.MAX_SAFE_INTEGER);
  gc?.();
  const memAfterFlush = process.memoryUsage().heapUsed;

  // Behaviorally fresh: a short sequence restarts counts from zero.
  const restart: HitSummary[] = [];
  for (let n = 0; n < 10; n++) {
    restart.push(
      ...detector.ingest([
        {
          eventId: `re-${n}`,
          agentId: "agent-1",
          ts: Number.MAX_SAFE_INTEGER + n,
          eventType: "EV",
        },
      ]),
    );
  }
  assert.equal(restart.length, 3); // n = 7, 8, 9
  assert.equal(restart[0].count, "1");
  assert.equal(restart[1].count, "8");
  assert.equal(restart[2].count, "36");

  const t1 = performance.now();
  const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`;
  console.log(
    `stress: ${N} events ingested in ${fmt(tMid - t0)} ` +
      `(total ${fmt(t1 - t0)} incl. verification); ` +
      `heap(incl. ${hits.length} retained hit summaries + test harness) ` +
      `before=${mb(memBefore)} afterStream=${mb(memAfterStream)} ` +
      `afterFlush=${mb(memAfterFlush)}; maxCount=${binom(W, K - 1)}`,
  );
});
