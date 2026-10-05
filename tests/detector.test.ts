import test from "node:test";
import assert from "node:assert/strict";
import { createDetector } from "../src/detector.ts";
import type { HitSummary, RuleSpec, TelemetryEvent } from "../src/types.ts";
import { bruteForceHits, sortHits } from "./reference.ts";

let seq = 0;
function ev(
  ts: number,
  eventType: string,
  agentId = "a1",
  payload?: Record<string, unknown>,
): TelemetryEvent {
  seq += 1;
  return { eventId: `e${seq}`, agentId, ts, eventType, payload };
}

function collectAll(hits: HitSummary[][]): HitSummary[] {
  return hits.flat();
}

test("identical repeated stages produce binomial counts", () => {
  const rules: RuleSpec[] = [
    { ruleId: "r", windowMs: 1000, stages: [{ eventType: "A" }, { eventType: "A" }, { eventType: "A" }] },
  ];
  const d = createDetector(rules);
  const events = [ev(0, "A"), ev(1, "A"), ev(2, "A"), ev(3, "A"), ev(4, "A")];
  const hits = d.ingest(events);
  // 3-stage chains ending at event n: C(n, 2) for n = 0..4 -> 0,0,1,3,6
  assert.deepEqual(
    hits.map((h) => [h.eventId, h.count]),
    [
      [events[2].eventId, "1"],
      [events[3].eventId, "3"],
      [events[4].eventId, "6"],
    ],
  );
  assert.deepEqual(sortHits(hits), sortHits(bruteForceHits(rules, events)));
});

test("one event matching multiple stages is not reused within a chain", () => {
  const rules: RuleSpec[] = [
    { ruleId: "r", windowMs: 1000, stages: [{ eventType: "A" }, { eventType: "A" }] },
  ];
  const d = createDetector(rules);
  const e1 = ev(0, "A");
  assert.deepEqual(d.ingest([e1]), []);
  const e2 = ev(1, "A");
  const hits = d.ingest([e2]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, "1"); // only (e1, e2); e2 cannot be both stages
});

test("same timestamps keep input order and W=0 still allows chains", () => {
  const rules: RuleSpec[] = [
    { ruleId: "r", windowMs: 0, stages: [{ eventType: "A" }, { eventType: "B" }] },
  ];
  const d = createDetector(rules);
  const bFirst = [ev(5, "B"), ev(5, "A"), ev(5, "B")];
  const hits = d.ingest(bFirst);
  // Only the A before the second B forms a chain; the first B has no prior A.
  assert.equal(hits.length, 1);
  assert.equal(hits[0].eventId, bFirst[2].eventId);
  assert.equal(hits[0].count, "1");
  assert.deepEqual(sortHits(hits), sortHits(bruteForceHits(rules, bFirst)));
});

test("window boundary is inclusive", () => {
  const rules: RuleSpec[] = [
    { ruleId: "r", windowMs: 100, stages: [{ eventType: "A" }, { eventType: "B" }] },
  ];
  const d = createDetector(rules);
  const a = ev(0, "A");
  const atBoundary = ev(100, "B");
  const hits1 = d.ingest([a, atBoundary]);
  assert.equal(hits1.length, 1); // span exactly 100 is allowed
  const pastBoundary = ev(101, "B");
  const hits2 = d.ingest([pastBoundary]);
  assert.equal(hits2.length, 0); // span 101 exceeds W
});

test("chains never cross agents", () => {
  const rules: RuleSpec[] = [
    { ruleId: "r", windowMs: 1000, stages: [{ eventType: "A" }, { eventType: "B" }] },
  ];
  const events = [
    ev(0, "A", "x"),
    ev(1, "A", "y"),
    ev(2, "B", "x"),
    ev(3, "B", "y"),
    ev(4, "B", "x"),
  ];
  const d = createDetector(rules);
  const hits = d.ingest(events);
  assert.deepEqual(
    sortHits(hits),
    sortHits(bruteForceHits(rules, events)),
  );
  // x: B@2 sees A@0 (1 chain), B@4 sees A@0 (1 chain); y: B@3 sees A@1.
  assert.equal(hits.length, 3);
  for (const h of hits) assert.equal(h.count, "1");
});

test("payload equality conditions: all must hold, missing field fails", () => {
  const rules: RuleSpec[] = [
    {
      ruleId: "r",
      windowMs: 1000,
      stages: [
        { eventType: "A", payloadEquals: { user: "root", tty: "pts0" } },
        { eventType: "B", payloadEquals: { user: "root" } },
      ],
    },
  ];
  const d = createDetector(rules);
  const missing = ev(0, "A", "a1", { user: "root" }); // missing tty
  const wrong = ev(1, "A", "a1", { user: "root", tty: "pts1" });
  const good = ev(2, "A", "a1", { user: "root", tty: "pts0", extra: 1 });
  const bNoPayload = ev(3, "B");
  const bWrong = ev(4, "B", "a1", { user: "admin" });
  const bGood = ev(5, "B", "a1", { user: "root" });
  const hits = d.ingest([missing, wrong, good, bNoPayload, bWrong, bGood]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].eventId, bGood.eventId);
  assert.equal(hits[0].count, "1"); // only `good` qualifies as stage 1
});

test("batch splits and advanceTo do not change results", () => {
  const rules: RuleSpec[] = [
    { ruleId: "r1", windowMs: 50, stages: [{ eventType: "A" }, { eventType: "B" }, { eventType: "C" }] },
    { ruleId: "r2", windowMs: 10, stages: [{ eventType: "A" }, { eventType: "A" }] },
  ];
  const events: TelemetryEvent[] = [];
  const types = ["A", "B", "C"];
  for (let i = 0; i < 60; i++) {
    events.push(ev(i * 7 % 61, types[i % 3], i % 2 === 0 ? "a1" : "a2"));
  }
  events.sort((x, y) => x.ts - y.ts); // non-decreasing ts, stable
  const expected = sortHits(bruteForceHits(rules, events));

  const oneShot = createDetector(rules);
  assert.deepEqual(sortHits(oneShot.ingest(events)), expected);

  // Many small batches with legal advanceTo calls interleaved.
  const drip = createDetector(rules);
  const got: HitSummary[] = [];
  let now = 0;
  for (const event of events) {
    if (event.ts - 3 > now) {
      drip.advanceTo(event.ts - 3); // >= current time, <= next event ts
      now = event.ts - 3;
    }
    got.push(...drip.ingest([event]));
    now = event.ts;
  }
  drip.advanceTo(10_000);
  assert.deepEqual(sortHits(got), expected);
});

test("advanceTo beyond all windows drops state; later events start fresh", () => {
  const rules: RuleSpec[] = [
    { ruleId: "r", windowMs: 10, stages: [{ eventType: "A" }, { eventType: "A" }] },
  ];
  const d = createDetector(rules);
  d.ingest([ev(0, "A"), ev(1, "A"), ev(2, "A")]);
  d.advanceTo(1_000_000);
  // If any stale state survived, these counts would be inflated.
  const hits = collectAll([
    d.ingest([ev(1_000_000, "A")]),
    d.ingest([ev(1_000_001, "A")]),
    d.ingest([ev(1_000_002, "A")]),
  ]);
  assert.deepEqual(
    hits.map((h) => h.count),
    ["1", "2"],
  );
});

test("time cannot move backwards", () => {
  const d = createDetector([
    { ruleId: "r", windowMs: 10, stages: [{ eventType: "A" }, { eventType: "B" }] },
  ]);
  d.ingest([ev(100, "A")]);
  assert.throws(() => d.advanceTo(99), /backwards/);
  assert.throws(() => d.ingest([ev(99, "B")]), /before current time/);
  d.advanceTo(100); // equal is fine
  d.ingest([ev(100, "B")]); // equal is fine
});

test("zero-count events produce no summary", () => {
  const d = createDetector([
    { ruleId: "r", windowMs: 10, stages: [{ eventType: "A" }, { eventType: "B" }] },
  ]);
  const hits = d.ingest([ev(0, "B"), ev(1, "B"), ev(2, "A")]);
  assert.deepEqual(hits, []);
});

test("randomized fuzz against exhaustive reference", () => {
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

  for (let iter = 0; iter < 400; iter++) {
    const types = ["A", "B", "C"];
    const keys = ["u", "v"];
    const values = ["0", "1"];
    const stageCount = 2 + Math.floor(rand() * 4); // 2..5 stages
    const rules: RuleSpec[] = [
      {
        ruleId: "r1",
        windowMs: pick([0, 1, 5, 20, 100]),
        stages: Array.from({ length: stageCount }, () => ({
          eventType: pick(types),
          ...(rand() < 0.5
            ? { payloadEquals: { [pick(keys)]: pick(values) } }
            : {}),
        })),
      },
      {
        ruleId: "r2",
        windowMs: pick([0, 3, 50]),
        stages: [
          { eventType: pick(types) },
          { eventType: pick(types) },
        ],
      },
    ];
    const n = 1 + Math.floor(rand() * 35);
    const events: TelemetryEvent[] = [];
    let ts = 0;
    for (let i = 0; i < n; i++) {
      ts += Math.floor(rand() * 4); // frequent equal timestamps
      const payload: Record<string, unknown> = {};
      if (rand() < 0.7) payload[pick(keys)] = pick(values);
      events.push(ev(ts, pick(types), pick(["a1", "a2", "a3"]), payload));
    }
    const expected = sortHits(bruteForceHits(rules, events));

    // Random batch split with occasional legal advanceTo.
    const d = createDetector(rules);
    const got: HitSummary[] = [];
    let i = 0;
    let clock = 0;
    while (i < events.length) {
      const size = 1 + Math.floor(rand() * 7);
      const batch = events.slice(i, i + size);
      if (rand() < 0.3 && batch[0].ts > clock) {
        const target = clock + Math.floor(rand() * (batch[0].ts - clock + 1));
        d.advanceTo(target);
        clock = target;
      }
      got.push(...d.ingest(batch));
      clock = batch[batch.length - 1].ts;
      i += size;
    }
    if (rand() < 0.5) d.advanceTo(clock + Math.floor(rand() * 1000));
    assert.deepEqual(sortHits(got), expected, `iteration ${iter} mismatch`);
  }
});
