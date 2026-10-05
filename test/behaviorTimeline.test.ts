import assert from "node:assert/strict";
import test from "node:test";
import { BehaviorTimeline, ObservationReport } from "../src/index";

function report(
  records: Array<{ id: string; startMs: number; endMs: number; occurred: boolean }>,
  totalLengthMs = 10_000,
): ObservationReport {
  const timeline = new BehaviorTimeline(totalLengthMs);
  for (const record of records) {
    timeline.submit(record);
  }
  return timeline.report(0, timeline.intervalCount);
}

test("constructor requires a positive multiple of 10000", () => {
  assert.throws(() => new BehaviorTimeline(0), RangeError);
  assert.throws(() => new BehaviorTimeline(15_000), RangeError);
  assert.throws(() => new BehaviorTimeline(-10_000), RangeError);
  assert.equal(new BehaviorTimeline(20_000).intervalCount, 2);
});

test("submit validates the record range", () => {
  const timeline = new BehaviorTimeline(10_000);
  assert.throws(
    () => timeline.submit({ id: "a", startMs: 5_000, endMs: 5_000, occurred: true }),
    RangeError,
  );
  assert.throws(
    () => timeline.submit({ id: "b", startMs: 0, endMs: 10_001, occurred: true }),
    RangeError,
  );
  assert.throws(
    () => timeline.submit({ id: "c", startMs: 0.5, endMs: 10_000, occurred: true }),
    RangeError,
  );
});

test("report range must cover whole intervals within the timeline", () => {
  const timeline = new BehaviorTimeline(20_000);
  assert.throws(() => timeline.report(-1, 1), RangeError);
  assert.throws(() => timeline.report(0, 3), RangeError);
  assert.throws(() => timeline.report(1, 1), RangeError);
  assert.throws(() => timeline.report(0.5, 1), RangeError);
});

test("overlapping same-kind records: retracting one keeps the conclusion supported by the others", () => {
  const timeline = new BehaviorTimeline(10_000);
  timeline.submit({ id: "a", startMs: 0, endMs: 10_000, occurred: true });
  timeline.submit({ id: "b", startMs: 2_000, endMs: 8_000, occurred: true });

  const before = timeline.report(0, 1);
  assert.equal(before.wholeInterval.occurred, 1);
  assert.equal(before.partialInterval.occurred, 1);
  assert.equal(before.momentarySampling.occurred, 1);

  timeline.retract("a");

  const after = timeline.report(0, 1);
  assert.deepEqual(after.partialInterval, {
    occurred: 1,
    notOccurred: 0,
    unknown: 0,
    occurredRatio: 1,
  });
  assert.deepEqual(after.momentarySampling, {
    occurred: 1,
    notOccurred: 0,
    unknown: 0,
    occurredRatio: 1,
  });
  // b does not cover [0,2000) and [8000,10000), so the whole-interval
  // method can no longer be certain and falls back to unknown.
  assert.deepEqual(after.wholeInterval, {
    occurred: 0,
    notOccurred: 0,
    unknown: 1,
    occurredRatio: null,
  });

  timeline.retract("b");
  const empty = timeline.report(0, 1);
  assert.deepEqual(empty.partialInterval, {
    occurred: 0,
    notOccurred: 0,
    unknown: 1,
    occurredRatio: null,
  });
});

test("conflicting records: correcting one resolves the conflict and updates the report", () => {
  const timeline = new BehaviorTimeline(10_000);
  timeline.submit({ id: "a", startMs: 0, endMs: 10_000, occurred: true });
  timeline.submit({ id: "b", startMs: 0, endMs: 10_000, occurred: false });

  const conflicted = timeline.report(0, 1);
  for (const stats of [
    conflicted.wholeInterval,
    conflicted.partialInterval,
    conflicted.momentarySampling,
  ]) {
    assert.deepEqual(stats, {
      occurred: 0,
      notOccurred: 0,
      unknown: 1,
      occurredRatio: null,
    });
  }

  // Reviewer corrects record b: it actually supports "occurred".
  timeline.submit({ id: "b", startMs: 0, endMs: 10_000, occurred: true });

  const resolved = timeline.report(0, 1);
  for (const stats of [
    resolved.wholeInterval,
    resolved.partialInterval,
    resolved.momentarySampling,
  ]) {
    assert.deepEqual(stats, {
      occurred: 1,
      notOccurred: 0,
      unknown: 0,
      occurredRatio: 1,
    });
  }

  // Correcting a alone re-introduces a conflict (a disagrees with b).
  timeline.submit({ id: "a", startMs: 0, endMs: 10_000, occurred: false });
  const reConflicted = timeline.report(0, 1);
  assert.equal(reConflicted.wholeInterval.unknown, 1);
  assert.equal(reConflicted.wholeInterval.occurredRatio, null);

  // Correcting b as well resolves everything to notOccurred.
  timeline.submit({ id: "b", startMs: 0, endMs: 10_000, occurred: false });
  const flipped = timeline.report(0, 1);
  for (const stats of [
    flipped.wholeInterval,
    flipped.partialInterval,
    flipped.momentarySampling,
  ]) {
    assert.deepEqual(stats, {
      occurred: 0,
      notOccurred: 1,
      unknown: 0,
      occurredRatio: 0,
    });
  }
});

test("whole-interval method: any certainly-not-occurred moment forces notOccurred", () => {
  const stats = report([
    { id: "a", startMs: 0, endMs: 9_000, occurred: true },
    { id: "b", startMs: 9_000, endMs: 10_000, occurred: false },
  ]).wholeInterval;
  assert.deepEqual(stats, {
    occurred: 0,
    notOccurred: 1,
    unknown: 0,
    occurredRatio: 0,
  });
});

test("whole-interval method: gaps in coverage lead to unknown", () => {
  const stats = report([
    { id: "a", startMs: 0, endMs: 6_000, occurred: true },
    { id: "b", startMs: 6_000, endMs: 9_999, occurred: true },
  ]).wholeInterval;
  assert.equal(stats.unknown, 1);
  assert.equal(stats.occurredRatio, null);
});

test("partial-interval method: any certainly-occurred moment is enough", () => {
  const stats = report([
    { id: "a", startMs: 4_000, endMs: 4_001, occurred: true },
    { id: "b", startMs: 0, endMs: 10_000, occurred: false },
  ]).partialInterval;
  // [4000,4001) is unknown (conflict), the rest is certainly notOccurred,
  // so no moment is certainly occurred and not everything is notOccurred.
  assert.deepEqual(stats, {
    occurred: 0,
    notOccurred: 0,
    unknown: 1,
    occurredRatio: null,
  });
});

test("partial-interval method: fully notOccurred interval", () => {
  const stats = report([
    { id: "a", startMs: 0, endMs: 5_000, occurred: false },
    { id: "b", startMs: 5_000, endMs: 10_000, occurred: false },
  ]).partialInterval;
  assert.deepEqual(stats, {
    occurred: 0,
    notOccurred: 1,
    unknown: 0,
    occurredRatio: 0,
  });
});

test("momentary sampling uses the conclusion at interval start + 5000ms", () => {
  const timeline = new BehaviorTimeline(20_000);
  timeline.submit({ id: "a", startMs: 0, endMs: 10_000, occurred: true });
  const result = timeline.report(0, 2);
  assert.equal(result.momentarySampling.occurred, 1);
  assert.equal(result.momentarySampling.unknown, 1);
  assert.equal(result.momentarySampling.occurredRatio, 1);
});

test("sampling point exactly at a record's right endpoint is not covered by it", () => {
  const timeline = new BehaviorTimeline(10_000);
  timeline.submit({ id: "a", startMs: 0, endMs: 5_000, occurred: true });
  const result = timeline.report(0, 1);
  assert.deepEqual(result.momentarySampling, {
    occurred: 0,
    notOccurred: 0,
    unknown: 1,
    occurredRatio: null,
  });
  // ...but a record starting exactly at the sampling point does cover it.
  timeline.submit({ id: "b", startMs: 5_000, endMs: 6_000, occurred: false });
  assert.equal(timeline.report(0, 1).momentarySampling.notOccurred, 1);
});

test("occurredRatio only counts decidable intervals", () => {
  const timeline = new BehaviorTimeline(40_000);
  timeline.submit({ id: "a", startMs: 0, endMs: 10_000, occurred: true });
  timeline.submit({ id: "b", startMs: 10_000, endMs: 20_000, occurred: false });
  // interval 2: conflict, interval 3: no records at all.
  timeline.submit({ id: "c", startMs: 20_000, endMs: 30_000, occurred: true });
  timeline.submit({ id: "d", startMs: 20_000, endMs: 30_000, occurred: false });

  const result = timeline.report(0, 4);
  assert.deepEqual(result.wholeInterval, {
    occurred: 1,
    notOccurred: 1,
    unknown: 2,
    occurredRatio: 0.5,
  });
  assert.deepEqual(result.partialInterval, {
    occurred: 1,
    notOccurred: 1,
    unknown: 2,
    occurredRatio: 0.5,
  });
  assert.deepEqual(result.momentarySampling, {
    occurred: 1,
    notOccurred: 1,
    unknown: 2,
    occurredRatio: 0.5,
  });
});

test("report can be restricted to a sub-range of intervals", () => {
  const timeline = new BehaviorTimeline(30_000);
  timeline.submit({ id: "a", startMs: 0, endMs: 10_000, occurred: true });
  const first = timeline.report(0, 1);
  assert.equal(first.wholeInterval.occurred, 1);
  const rest = timeline.report(1, 3);
  assert.equal(rest.wholeInterval.unknown, 2);
  assert.equal(rest.wholeInterval.occurredRatio, null);
});

test("retracting an unknown id is a no-op", () => {
  const timeline = new BehaviorTimeline(10_000);
  timeline.submit({ id: "a", startMs: 0, endMs: 10_000, occurred: true });
  timeline.retract("missing");
  assert.equal(timeline.report(0, 1).wholeInterval.occurred, 1);
});
