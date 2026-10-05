import test from "node:test";
import assert from "node:assert/strict";
import { ObservationTimeline } from "../src/index";

test("同类记录重叠后撤销其中一条，仍保留其他记录支持的结论", () => {
  const timeline = new ObservationTimeline(10000);
  timeline.submit({ id: "a", startMs: 0, endMs: 10000, verdict: "occurred" });
  timeline.submit({ id: "b", startMs: 0, endMs: 10000, verdict: "occurred" });

  timeline.revoke("a");

  assert.equal(timeline.stateAt(0), "occurred");
  assert.equal(timeline.stateAt(5000), "occurred");
  assert.equal(timeline.stateAt(9999), "occurred");
});

test("异类记录重叠后更正其中一条，消除冲突", () => {
  const timeline = new ObservationTimeline(10000);
  timeline.submit({ id: "x", startMs: 0, endMs: 10000, verdict: "occurred" });
  timeline.submit({ id: "y", startMs: 0, endMs: 10000, verdict: "notOccurred" });
  assert.equal(timeline.stateAt(5000), "unknown");

  // 复核更正：同 id 重新提交即完整替换
  timeline.submit({ id: "y", startMs: 0, endMs: 10000, verdict: "occurred" });
  assert.equal(timeline.stateAt(5000), "occurred");
});

test("无记录覆盖的时刻为未知", () => {
  const timeline = new ObservationTimeline(10000);
  assert.equal(timeline.stateAt(5000), "unknown");
});

test("记录范围左闭右开", () => {
  const timeline = new ObservationTimeline(10000);
  timeline.submit({ id: "a", startMs: 2000, endMs: 5000, verdict: "occurred" });
  assert.equal(timeline.stateAt(1999), "unknown");
  assert.equal(timeline.stateAt(2000), "occurred");
  assert.equal(timeline.stateAt(4999), "occurred");
  assert.equal(timeline.stateAt(5000), "unknown");
});

test("撤销不存在的记录不影响其他记录", () => {
  const timeline = new ObservationTimeline(10000);
  timeline.submit({ id: "a", startMs: 0, endMs: 10000, verdict: "notOccurred" });
  timeline.revoke("missing");
  assert.equal(timeline.stateAt(5000), "notOccurred");
});

test("非法输入被拒绝", () => {
  assert.throws(() => new ObservationTimeline(0), RangeError);
  assert.throws(() => new ObservationTimeline(15000), RangeError);
  const timeline = new ObservationTimeline(10000);
  assert.throws(
    () => timeline.submit({ id: "a", startMs: 5000, endMs: 5000, verdict: "occurred" }),
    RangeError,
  );
  assert.throws(
    () => timeline.submit({ id: "a", startMs: 0, endMs: 10001, verdict: "occurred" }),
    RangeError,
  );
});
