import test from "node:test";
import assert from "node:assert/strict";
import { ObservationTimeline, buildReport } from "../src/index";

test("整段记录法：全区间确定发生才判发生，任一确定未发生即判未发生", () => {
  const timeline = new ObservationTimeline(30000);
  // 区间 0：整段发生
  timeline.submit({ id: "a", startMs: 0, endMs: 10000, verdict: "occurred" });
  // 区间 1：前半段确定发生，后半段确定未发生
  timeline.submit({ id: "b", startMs: 10000, endMs: 15000, verdict: "occurred" });
  timeline.submit({ id: "c", startMs: 15000, endMs: 20000, verdict: "notOccurred" });
  // 区间 2：部分时段发生，其余无记录
  timeline.submit({ id: "d", startMs: 20000, endMs: 20100, verdict: "occurred" });

  const report = buildReport(timeline, 0, 3);
  assert.deepEqual(report.whole, {
    occurred: 1,
    notOccurred: 1,
    unknown: 1,
    occurredRatio: 0.5,
  });
});

test("部分记录法：任一确定发生即判发生，整段确定未发生才判未发生", () => {
  const timeline = new ObservationTimeline(30000);
  // 区间 0：只有一小段发生
  timeline.submit({ id: "a", startMs: 100, endMs: 200, verdict: "occurred" });
  // 区间 1：整段未发生
  timeline.submit({ id: "b", startMs: 10000, endMs: 20000, verdict: "notOccurred" });
  // 区间 2：发生与未发生同时覆盖，冲突为未知
  timeline.submit({ id: "c", startMs: 20000, endMs: 30000, verdict: "occurred" });
  timeline.submit({ id: "d", startMs: 20000, endMs: 30000, verdict: "notOccurred" });

  const report = buildReport(timeline, 0, 3);
  assert.deepEqual(report.partial, {
    occurred: 1,
    notOccurred: 1,
    unknown: 1,
    occurredRatio: 0.5,
  });
});

test("瞬时采样：取区间开始后 5000ms 的时刻，右端点不覆盖采样点", () => {
  const timeline = new ObservationTimeline(30000);
  // 区间 0：记录右端点恰好等于采样点 5000，不覆盖
  timeline.submit({ id: "a", startMs: 0, endMs: 5000, verdict: "occurred" });
  // 区间 1：记录覆盖采样点 15000
  timeline.submit({ id: "b", startMs: 10000, endMs: 15001, verdict: "notOccurred" });
  // 区间 2：采样点处发生与未发生冲突
  timeline.submit({ id: "c", startMs: 24000, endMs: 26000, verdict: "occurred" });
  timeline.submit({ id: "d", startMs: 24000, endMs: 26000, verdict: "notOccurred" });

  const report = buildReport(timeline, 0, 3);
  assert.deepEqual(report.momentary, {
    occurred: 0,
    notOccurred: 1,
    unknown: 2,
    occurredRatio: 0,
  });
});

test("撤销重叠记录后报告仍反映其他记录支持的结论", () => {
  const timeline = new ObservationTimeline(10000);
  timeline.submit({ id: "a", startMs: 0, endMs: 10000, verdict: "occurred" });
  timeline.submit({ id: "b", startMs: 0, endMs: 10000, verdict: "occurred" });

  timeline.revoke("a");

  const report = buildReport(timeline, 0, 1);
  assert.deepEqual(report.whole, {
    occurred: 1,
    notOccurred: 0,
    unknown: 0,
    occurredRatio: 1,
  });
  assert.deepEqual(report.partial, report.whole);
  assert.deepEqual(report.momentary, report.whole);
});

test("更正冲突记录后报告随之更新", () => {
  const timeline = new ObservationTimeline(10000);
  timeline.submit({ id: "x", startMs: 0, endMs: 10000, verdict: "occurred" });
  timeline.submit({ id: "y", startMs: 0, endMs: 10000, verdict: "notOccurred" });

  const before = buildReport(timeline, 0, 1);
  assert.equal(before.whole.unknown, 1);
  assert.equal(before.whole.occurredRatio, null);

  timeline.submit({ id: "y", startMs: 0, endMs: 10000, verdict: "occurred" });

  const after = buildReport(timeline, 0, 1);
  assert.deepEqual(after.whole, {
    occurred: 1,
    notOccurred: 0,
    unknown: 0,
    occurredRatio: 1,
  });
});

test("比例只以发生和未发生区间之和为分母，无可判定区间时不计算", () => {
  const timeline = new ObservationTimeline(30000);
  timeline.submit({ id: "a", startMs: 0, endMs: 10000, verdict: "occurred" });
  // 区间 1、2 无记录，整段法下为未知

  const report = buildReport(timeline, 0, 3);
  assert.deepEqual(report.whole, {
    occurred: 1,
    notOccurred: 0,
    unknown: 2,
    occurredRatio: 1,
  });

  const empty = buildReport(new ObservationTimeline(10000), 0, 1);
  assert.equal(empty.whole.occurredRatio, null);
  assert.equal(empty.partial.occurredRatio, null);
  assert.equal(empty.momentary.occurredRatio, null);
});

test("报告范围按完整区间指定，非法范围被拒绝", () => {
  const timeline = new ObservationTimeline(20000);
  timeline.submit({ id: "a", startMs: 10000, endMs: 20000, verdict: "occurred" });

  const report = buildReport(timeline, 1, 2);
  assert.equal(report.whole.occurred, 1);

  assert.throws(() => buildReport(timeline, 0, 3), RangeError);
  assert.throws(() => buildReport(timeline, 2, 1), RangeError);
});
