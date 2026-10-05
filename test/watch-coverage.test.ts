import { WatchCoverageLedger, ScopeKey } from "../src/index";
import { test, assertEqual, assertTrue, assertFalse } from "./harness";

const DURATION = 60_000; // 影片总时长 60 秒

function key(tenantId: string, profileId = "p1", videoId = "v1"): ScopeKey {
  return { tenantId, profileId, videoId };
}

test("没有有效片段时覆盖量为零", () => {
  const ledger = new WatchCoverageLedger();
  const progress = ledger.getProgress(key("t1"), DURATION);
  assertEqual(progress.coveredMs, 0);
  assertFalse(progress.completed);
});

test("重复观看同一位置只计一次", () => {
  const ledger = new WatchCoverageLedger();
  const k = key("t1");
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 1, startMs: 0, endMs: 10_000 });
  ledger.upsertSegment(k, DURATION, { segmentId: "b", version: 1, startMs: 5_000, endMs: 15_000 });
  ledger.upsertSegment(k, DURATION, { segmentId: "c", version: 1, startMs: 0, endMs: 10_000 });
  const progress = ledger.getProgress(k, DURATION);
  assertEqual(progress.coveredMs, 15_000);
  assertFalse(progress.completed);
});

test("同版本重放与较低版本补报不改变结果", () => {
  const ledger = new WatchCoverageLedger();
  const k = key("t1");
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 3, startMs: 0, endMs: 10_000 });
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 3, startMs: 0, endMs: 10_000 });
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 1, startMs: 0, endMs: 10_000 });
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 2, startMs: 0, endMs: 10_000 });
  assertEqual(ledger.getProgress(k, DURATION).coveredMs, 10_000);
});

test("修订是整体替换旧区间", () => {
  const ledger = new WatchCoverageLedger();
  const k = key("t1");
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 1, startMs: 0, endMs: 30_000 });
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 2, startMs: 40_000, endMs: 50_000 });
  const progress = ledger.getProgress(k, DURATION);
  assertEqual(progress.coveredMs, 10_000);
});

test("嵌套重叠后撤销外层片段，剩余覆盖由其他有效片段决定", () => {
  const ledger = new WatchCoverageLedger();
  const k = key("t1");
  ledger.upsertSegment(k, DURATION, { segmentId: "outer", version: 1, startMs: 0, endMs: 50_000 });
  ledger.upsertSegment(k, DURATION, { segmentId: "inner", version: 1, startMs: 10_000, endMs: 20_000 });
  assertEqual(ledger.getProgress(k, DURATION).coveredMs, 50_000);
  ledger.revokeSegment(k, DURATION, "outer", 2);
  const progress = ledger.getProgress(k, DURATION);
  assertEqual(progress.coveredMs, 10_000);
});

test("撤销只移除该标识的贡献，不抹掉其他片段的覆盖", () => {
  const ledger = new WatchCoverageLedger();
  const k = key("t1");
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 1, startMs: 0, endMs: 30_000 });
  ledger.upsertSegment(k, DURATION, { segmentId: "b", version: 1, startMs: 10_000, endMs: 40_000 });
  ledger.revokeSegment(k, DURATION, "a", 2);
  assertEqual(ledger.getProgress(k, DURATION).coveredMs, 30_000);
});

test("撤销可以先于登记到达，旧版本不得复活，更高版本可重新生效", () => {
  const ledger = new WatchCoverageLedger();
  const k = key("t1");
  // 撤销先到
  ledger.revokeSegment(k, DURATION, "a", 2);
  assertEqual(ledger.getProgress(k, DURATION).coveredMs, 0);
  // 旧版本补报：不得复活
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 1, startMs: 0, endMs: 10_000 });
  assertEqual(ledger.getProgress(k, DURATION).coveredMs, 0);
  // 同版本补报：不得复活
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 2, startMs: 0, endMs: 10_000 });
  assertEqual(ledger.getProgress(k, DURATION).coveredMs, 0);
  // 更高版本登记：重新生效
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 3, startMs: 0, endMs: 10_000 });
  assertEqual(ledger.getProgress(k, DURATION).coveredMs, 10_000);
});

test("撤销旧版本不影响更高版本的有效片段", () => {
  const ledger = new WatchCoverageLedger();
  const k = key("t1");
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 3, startMs: 0, endMs: 10_000 });
  ledger.revokeSegment(k, DURATION, "a", 2);
  assertEqual(ledger.getProgress(k, DURATION).coveredMs, 10_000);
  ledger.revokeSegment(k, DURATION, "a", 4);
  assertEqual(ledger.getProgress(k, DURATION).coveredMs, 0);
});

test("覆盖量达到 90% 即完成，且完成状态可双向变化", () => {
  const ledger = new WatchCoverageLedger();
  const k = key("t1");
  // 覆盖 0..54000，恰为 90%
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 1, startMs: 0, endMs: 54_000 });
  assertTrue(ledger.getProgress(k, DURATION).completed);
  // 撤销后完成状态回退
  ledger.revokeSegment(k, DURATION, "a", 2);
  assertFalse(ledger.getProgress(k, DURATION).completed);
  // 更高版本恢复后再次完成
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 3, startMs: 0, endMs: 54_000 });
  assertTrue(ledger.getProgress(k, DURATION).completed);
  // 修订缩短区间后再次变为未完成
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 4, startMs: 0, endMs: 10_000 });
  assertFalse(ledger.getProgress(k, DURATION).completed);
});

test("90% 判定不四舍五入", () => {
  const ledger = new WatchCoverageLedger();
  const k = key("t1");
  const duration = 1_001;
  // 900/1001 ≈ 89.91%，未完成
  ledger.upsertSegment(k, duration, { segmentId: "a", version: 1, startMs: 0, endMs: 900 });
  assertFalse(ledger.getProgress(k, duration).completed);
  // 901/1001 ≈ 90.01%，完成
  ledger.upsertSegment(k, duration, { segmentId: "b", version: 1, startMs: 900, endMs: 901 });
  assertTrue(ledger.getProgress(k, duration).completed);
});

test("首尾相接的片段合并计算", () => {
  const ledger = new WatchCoverageLedger();
  const k = key("t1");
  ledger.upsertSegment(k, DURATION, { segmentId: "a", version: 1, startMs: 0, endMs: 30_000 });
  ledger.upsertSegment(k, DURATION, { segmentId: "b", version: 1, startMs: 30_000, endMs: 60_000 });
  const progress = ledger.getProgress(k, DURATION);
  assertEqual(progress.coveredMs, 60_000);
  assertTrue(progress.completed);
});

test("相同标识不会跨租户串扰", () => {
  const ledger = new WatchCoverageLedger();
  const k1 = key("tenant-a");
  const k2 = key("tenant-b");
  ledger.upsertSegment(k1, DURATION, { segmentId: "seg", version: 1, startMs: 0, endMs: 54_000 });
  // 租户 B 用相同片段标识，互不影响
  assertEqual(ledger.getProgress(k2, DURATION).coveredMs, 0);
  ledger.upsertSegment(k2, DURATION, { segmentId: "seg", version: 1, startMs: 0, endMs: 5_000 });
  assertEqual(ledger.getProgress(k1, DURATION).coveredMs, 54_000);
  assertEqual(ledger.getProgress(k2, DURATION).coveredMs, 5_000);
  // 租户 B 撤销不影响租户 A
  ledger.revokeSegment(k2, DURATION, "seg", 2);
  assertEqual(ledger.getProgress(k2, DURATION).coveredMs, 0);
  assertEqual(ledger.getProgress(k1, DURATION).coveredMs, 54_000);
  assertTrue(ledger.getProgress(k1, DURATION).completed);
  // 租户 A 的撤销先到也不影响租户 B 后续登记
  ledger.revokeSegment(k1, DURATION, "seg", 5);
  ledger.upsertSegment(k2, DURATION, { segmentId: "seg", version: 3, startMs: 0, endMs: 8_000 });
  assertEqual(ledger.getProgress(k2, DURATION).coveredMs, 8_000);
});

test("不同档案与不同影片相互隔离", () => {
  const ledger = new WatchCoverageLedger();
  ledger.upsertSegment(key("t1", "p1", "v1"), DURATION, { segmentId: "s", version: 1, startMs: 0, endMs: 10_000 });
  assertEqual(ledger.getProgress(key("t1", "p2", "v1"), DURATION).coveredMs, 0);
  assertEqual(ledger.getProgress(key("t1", "p1", "v2"), DURATION).coveredMs, 0);
  assertEqual(ledger.getProgress(key("t1", "p1", "v1"), DURATION).coveredMs, 10_000);
});
