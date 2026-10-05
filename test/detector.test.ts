import { test } from "node:test";
import assert from "node:assert/strict";
import { createDetector } from "../src/index";
import type { HitSummary, Rule, TelemetryEvent } from "../src/types";
import { ReferenceDetector, summarize } from "./reference";

let nextEventId = 0;
function ev(
  ts: number,
  eventType: string,
  agentId = "a1",
  payload: Record<string, string> = {},
): TelemetryEvent {
  return { eventId: `e${nextEventId++}`, agentId, ts, eventType, payload };
}

function stage(
  eventType: string,
  conditions: Record<string, string> = {},
): { eventType: string; conditions: Record<string, string> } {
  return { eventType, conditions };
}

function assertHitsEqual(actual: HitSummary[], expected: HitSummary[]): void {
  assert.deepEqual(summarize(actual), summarize(expected));
}

test("duplicate identical stages count combinations exactly", () => {
  // 3 identical stages, W large: count for n-th event = C(n-1, 2).
  const rules: Rule[] = [
    { ruleId: "r1", windowMs: 1000, stages: [stage("A"), stage("A"), stage("A")] },
  ];
  const det = createDetector(rules);
  const ref = new ReferenceDetector(rules);
  const events = [ev(0, "A"), ev(1, "A"), ev(2, "A"), ev(3, "A"), ev(4, "A")];
  assertHitsEqual(det.ingest(events), ref.ingest(events));
  const hits = det.ingest([ev(5, "A")]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.count, "10"); // C(5,2) = 10 chains end at the 6th event
});

test("one event matching multiple stages simultaneously", () => {
  // Stages A then A-or-B: a single 'A' event can serve as stage 1 and/or 2,
  // but a chain may not reuse an event.
  const rules: Rule[] = [
    { ruleId: "r1", windowMs: 100, stages: [stage("A"), stage("A")] },
  ];
  const det = createDetector(rules);
  const ref = new ReferenceDetector(rules);
  const events = [ev(0, "A"), ev(0, "A"), ev(1, "A")];
  assertHitsEqual(det.ingest(events), ref.ingest(events));
});

test("same timestamps keep input order and match across equal ts", () => {
  const rules: Rule[] = [
    { ruleId: "r1", windowMs: 0, stages: [stage("A"), stage("B")] },
  ];
  const det = createDetector(rules);
  const ref = new ReferenceDetector(rules);
  const events = [
    ev(5, "A"),
    ev(5, "B"), // matches: same ts, window 0, diff = 0 <= 0
    ev(5, "B"), // second B also closes a chain
    ev(5, "A"),
    ev(5, "B"), // closes chains for both prior A's
  ];
  const hits = det.ingest(events);
  assertHitsEqual(hits, ref.ingest(events));
  assert.deepEqual(
    hits.map((h) => h.count),
    ["1", "1", "2"],
  );
});

test("window boundary is inclusive", () => {
  const rules: Rule[] = [
    { ruleId: "r1", windowMs: 10, stages: [stage("A"), stage("B")] },
  ];
  const det = createDetector(rules);
  const ref = new ReferenceDetector(rules);
  const batch1 = [ev(0, "A"), ev(10, "B")]; // diff exactly W -> hit
  const hits1 = det.ingest(batch1);
  assertHitsEqual(hits1, ref.ingest(batch1));
  assert.equal(hits1.length, 1);
  const batch2 = [ev(11, "B")]; // A at ts=0 is now 11 > W away -> no hit
  const hits2 = det.ingest(batch2);
  assertHitsEqual(hits2, ref.ingest(batch2));
  assert.equal(hits2.length, 0);
  const batch3 = [ev(11, "A"), ev(21, "B")]; // diff exactly 10 -> hit
  const hits3 = det.ingest(batch3);
  assertHitsEqual(hits3, ref.ingest(batch3));
  assert.equal(hits3.length, 1);
});

test("payload equality conditions and missing fields", () => {
  const rules: Rule[] = [
    {
      ruleId: "r1",
      windowMs: 100,
      stages: [stage("A", { k: "v", x: "1" }), stage("B", { k: "v" })],
    },
  ];
  const det = createDetector(rules);
  const ref = new ReferenceDetector(rules);
  const events = [
    ev(0, "A", "a1", { k: "v" }), // missing x -> no match
    ev(1, "A", "a1", { k: "v", x: "1", extra: "ok" }), // matches
    ev(2, "B", "a1", { k: "v" }), // closes exactly one chain
    ev(3, "B", "a1", { k: "other" }), // no match
  ];
  const hits = det.ingest(events);
  assertHitsEqual(hits, ref.ingest(events));
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.count, "1");
});

test("multi-agent interleaving keeps chains per agent", () => {
  const rules: Rule[] = [
    { ruleId: "r1", windowMs: 100, stages: [stage("A"), stage("A")] },
  ];
  const det = createDetector(rules);
  const ref = new ReferenceDetector(rules);
  const events = [
    ev(0, "A", "a1"),
    ev(1, "A", "a2"),
    ev(2, "A", "a1"),
    ev(3, "A", "a2"),
    ev(4, "A", "a1"),
  ];
  const hits = det.ingest(events);
  assertHitsEqual(hits, ref.ingest(events));
  assert.deepEqual(
    hits.map((h) => `${h.agentId}:${h.count}`),
    ["a1:1", "a2:1", "a1:2"],
  );
});

test("predicate containment between stages", () => {
  // Stage 1 requires {k: v}; stage 2 accepts any 'A'. Every stage-1 event
  // also matches stage 2.
  const rules: Rule[] = [
    {
      ruleId: "r1",
      windowMs: 50,
      stages: [stage("A", { k: "v" }), stage("A"), stage("A", { k: "v" })],
    },
  ];
  const det = createDetector(rules);
  const ref = new ReferenceDetector(rules);
  const events = [
    ev(0, "A", "a1", { k: "v" }),
    ev(1, "A", "a1", {}),
    ev(2, "A", "a1", { k: "v" }),
    ev(3, "A", "a1", { k: "v" }),
  ];
  assertHitsEqual(det.ingest(events), ref.ingest(events));
});

test("count zero produces no summary", () => {
  const rules: Rule[] = [
    { ruleId: "r1", windowMs: 10, stages: [stage("A"), stage("B")] },
  ];
  const det = createDetector(rules);
  assert.deepEqual(det.ingest([ev(0, "B"), ev(1, "B")]), []);
  assert.deepEqual(det.ingest([ev(2, "A")]), []);
});

test("batch splitting and advanceTo do not change results", () => {
  const rules: Rule[] = [
    { ruleId: "r1", windowMs: 20, stages: [stage("A"), stage("A"), stage("B")] },
    { ruleId: "r2", windowMs: 5, stages: [stage("B"), stage("A")] },
  ];
  const stream: TelemetryEvent[] = [];
  let ts = 0;
  const agents = ["a1", "a2", "a3"];
  const types = ["A", "B", "C"];
  for (let i = 0; i < 60; i++) {
    ts += i % 3; // non-decreasing with frequent equal timestamps
    stream.push(ev(ts, types[i % 3]!, agents[i % 3]!));
  }

  const ref = new ReferenceDetector(rules);
  const expected: HitSummary[] = [];
  for (const e of stream) expected.push(...ref.ingest([e]));

  // One big batch.
  const det1 = createDetector(rules);
  assertHitsEqual(det1.ingest(stream), expected);

  // Single-event batches with advanceTo calls interleaved.
  const det2 = createDetector(rules);
  const actual: HitSummary[] = [];
  let lastTs = 0;
  for (const e of stream) {
    actual.push(...det2.ingest([e]));
    if (e.ts > lastTs) {
      det2.advanceTo(e.ts);
      lastTs = e.ts;
    }
  }
  assertHitsEqual(actual, expected);

  // Odd-sized batches plus a far-future advance in the middle.
  const det3 = createDetector(rules);
  const actual3: HitSummary[] = [];
  let i = 0;
  while (i < stream.length) {
    const size = (i % 7) + 1;
    actual3.push(...det3.ingest(stream.slice(i, i + size)));
    i += size;
    if (i === 21) det3.advanceTo(stream[i - 1]!.ts); // no-op time move
  }
  det3.advanceTo(10_000);
  assertHitsEqual(actual3, expected);
});

test("advanceTo expires state and frees idle agents", () => {
  const rules: Rule[] = [
    { ruleId: "r1", windowMs: 10, stages: [stage("A"), stage("B")] },
  ];
  const det = createDetector(rules);
  det.ingest([ev(0, "A")]);
  det.advanceTo(100); // everything expired
  // The old A must not pair with a later B.
  const hits = det.ingest([ev(100, "B"), ev(101, "A"), ev(105, "B")]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.eventId, "e2" === hits[0]!.eventId ? "e2" : hits[0]!.eventId);
  assert.equal(hits[0]!.count, "1");
});

test("time cannot move backwards", () => {
  const rules: Rule[] = [
    { ruleId: "r1", windowMs: 10, stages: [stage("A"), stage("B")] },
  ];
  const det = createDetector(rules);
  det.ingest([ev(10, "A")]);
  assert.throws(() => det.ingest([ev(9, "A")]));
  assert.throws(() => det.advanceTo(9));
  det.advanceTo(10); // equal is allowed
  det.advanceTo(11);
});

test("rule validation", () => {
  assert.throws(() =>
    createDetector([{ ruleId: "x", windowMs: 1, stages: [stage("A")] }]),
  );
  assert.throws(() =>
    createDetector([
      { ruleId: "x", windowMs: 1, stages: Array(9).fill(stage("A")) },
    ]),
  );
  assert.throws(() =>
    createDetector([
      { ruleId: "x", windowMs: -1, stages: [stage("A"), stage("A")] },
    ]),
  );
});

test("randomized fuzz against brute-force reference", () => {
  let seed = 0x2f6e2b1;
  const rand = (): number => {
    // xorshift32
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

  for (let trial = 0; trial < 30; trial++) {
    const typeCount = 1 + Math.floor(rand() * 3);
    const types = Array.from({ length: typeCount }, (_, i) => `T${i}`);
    const ruleCount = 1 + Math.floor(rand() * 3);
    const rules: Rule[] = [];
    for (let r = 0; r < ruleCount; r++) {
      const stageCount = 2 + Math.floor(rand() * 7);
      const stages = [];
      for (let s = 0; s < stageCount; s++) {
        const conditions: Record<string, string> = {};
        if (rand() < 0.5) conditions.k = pick(["v0", "v1"]);
        if (rand() < 0.3) conditions.x = "1";
        stages.push(stage(pick(types), conditions));
      }
      rules.push({
        ruleId: `rule${r}`,
        windowMs: Math.floor(rand() * 30),
        stages,
      });
    }

    const agentCount = 1 + Math.floor(rand() * 3);
    const agents = Array.from({ length: agentCount }, (_, i) => `ag${i}`);
    const eventCount = 40 + Math.floor(rand() * 120);
    const events: TelemetryEvent[] = [];
    let ts = 0;
    for (let i = 0; i < eventCount; i++) {
      ts += Math.floor(rand() * 4);
      const payload: Record<string, string> = {};
      if (rand() < 0.7) payload.k = pick(["v0", "v1", "v2"]);
      if (rand() < 0.4) payload.x = "1";
      events.push(ev(ts, pick(types), pick(agents), payload));
    }

    // Random batching with random (legal) advanceTo calls.
    const det = createDetector(rules);
    const ref = new ReferenceDetector(rules);
    const actual: HitSummary[] = [];
    const expected: HitSummary[] = [];
    let i = 0;
    let now = 0;
    while (i < events.length) {
      const size = 1 + Math.floor(rand() * 10);
      const batch = events.slice(i, i + size);
      i += size;
      actual.push(...det.ingest(batch));
      expected.push(...ref.ingest(batch));
      now = batch[batch.length - 1]!.ts;
      if (rand() < 0.4) {
        // Advance only as far as the next event's ts (or freely at the end).
        const limit = i < events.length ? events[i]!.ts : now + 50;
        const target = now + Math.floor(rand() * (limit - now + 1));
        det.advanceTo(target);
        ref.advanceTo(target);
      }
    }
    assertHitsEqual(actual, expected);
  }
});
