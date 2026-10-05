import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { createWatchCoverageService, ObjectKey } from "../src/index";

function key(tenantId: string, profileId: string, videoId: string): ObjectKey {
  return { tenantId, profileId, videoId };
}

test("重复观看同一位置只计一次，嵌套区间不重复累计", () => {
  const svc = createWatchCoverageService();
  const k = key("t1", "p1", "v1");
  svc.upsertSegment(k, 1000, { segmentId: "a", version: 1, startMs: 0, endMs: 500 });
  svc.upsertSegment(k, 1000, { segmentId: "b", version: 1, startMs: 0, endMs: 500 });
  svc.upsertSegment(k, 1000, { segmentId: "c", version: 1, startMs: 200, endMs: 400 });
  deepEqual(svc.getProgress(k), { coveredMs: 500, completed: false });
});

test("嵌套重叠后撤销外层片段，剩余覆盖由其他有效片段决定", () => {
  const svc = createWatchCoverageService();
  const k = key("t1", "p1", "v1");
  svc.upsertSegment(k, 800, { segmentId: "outer", version: 1, startMs: 0, endMs: 600 });
  svc.upsertSegment(k, 800, { segmentId: "inner", version: 1, startMs: 100, endMs: 300 });
  svc.upsertSegment(k, 800, { segmentId: "tail", version: 1, startMs: 500, endMs: 800 });
  deepEqual(svc.getProgress(k), { coveredMs: 800, completed: true });

  svc.revokeSegment(k, "outer", 1);
  deepEqual(svc.getProgress(k), { coveredMs: 500, completed: false });
});

test("修订整体替换旧区间，同版本重放与较低版本不改变结果", () => {
  const svc = createWatchCoverageService();
  const k = key("t1", "p1", "v1");
  svc.upsertSegment(k, 1000, { segmentId: "a", version: 1, startMs: 0, endMs: 500 });
  deepEqual(svc.getProgress(k).coveredMs, 500);

  svc.upsertSegment(k, 1000, { segmentId: "a", version: 2, startMs: 600, endMs: 700 });
  deepEqual(svc.getProgress(k).coveredMs, 100);

  svc.upsertSegment(k, 1000, { segmentId: "a", version: 2, startMs: 600, endMs: 700 });
  svc.upsertSegment(k, 1000, { segmentId: "a", version: 1, startMs: 0, endMs: 500 });
  deepEqual(svc.getProgress(k).coveredMs, 100);
});

test("撤销先到：旧版本补报不复活，更高版本登记重新生效", () => {
  const svc = createWatchCoverageService();
  const k = key("t1", "p1", "v1");
  svc.revokeSegment(k, "a", 3);
  deepEqual(svc.getProgress(k), { coveredMs: 0, completed: false });

  svc.upsertSegment(k, 1000, { segmentId: "a", version: 2, startMs: 0, endMs: 500 });
  svc.upsertSegment(k, 1000, { segmentId: "a", version: 3, startMs: 0, endMs: 500 });
  deepEqual(svc.getProgress(k), { coveredMs: 0, completed: false });

  svc.upsertSegment(k, 1000, { segmentId: "a", version: 4, startMs: 0, endMs: 500 });
  deepEqual(svc.getProgress(k), { coveredMs: 500, completed: false });
});

test("完成状态可随修订与撤销双向变化", () => {
  const svc = createWatchCoverageService();
  const k = key("t1", "p1", "v1");
  svc.upsertSegment(k, 1000, { segmentId: "a", version: 1, startMs: 0, endMs: 950 });
  deepEqual(svc.getProgress(k), { coveredMs: 950, completed: true });

  svc.revokeSegment(k, "a", 2);
  deepEqual(svc.getProgress(k), { coveredMs: 0, completed: false });

  svc.upsertSegment(k, 1000, { segmentId: "a", version: 3, startMs: 0, endMs: 950 });
  deepEqual(svc.getProgress(k), { coveredMs: 950, completed: true });

  svc.upsertSegment(k, 1000, { segmentId: "a", version: 4, startMs: 0, endMs: 100 });
  deepEqual(svc.getProgress(k), { coveredMs: 100, completed: false });
});

test("90% 完成阈值按精确比较，不四舍五入", () => {
  const svc = createWatchCoverageService();
  const k = key("t1", "p1", "v1");
  svc.upsertSegment(k, 999, { segmentId: "a", version: 1, startMs: 0, endMs: 899 });
  deepEqual(svc.getProgress(k), { coveredMs: 899, completed: false });

  svc.upsertSegment(k, 999, { segmentId: "a", version: 2, startMs: 0, endMs: 900 });
  deepEqual(svc.getProgress(k), { coveredMs: 900, completed: true });

  const k2 = key("t1", "p1", "v2");
  svc.upsertSegment(k2, 1000, { segmentId: "a", version: 1, startMs: 0, endMs: 899 });
  deepEqual(svc.getProgress(k2), { coveredMs: 899, completed: false });
  svc.upsertSegment(k2, 1000, { segmentId: "a", version: 2, startMs: 100, endMs: 1000 });
  deepEqual(svc.getProgress(k2), { coveredMs: 900, completed: true });
});

test("相同片段标识在不同租户、档案、影片之间互不影响", () => {
  const svc = createWatchCoverageService();
  const a = key("tenantA", "p1", "v1");
  const b = key("tenantB", "p1", "v1");
  const c = key("tenantA", "p2", "v1");
  const d = key("tenantA", "p1", "v2");

  svc.upsertSegment(a, 1000, { segmentId: "s", version: 1, startMs: 0, endMs: 500 });
  svc.upsertSegment(b, 1000, { segmentId: "s", version: 1, startMs: 0, endMs: 200 });

  svc.revokeSegment(b, "s", 1);
  svc.revokeSegment(c, "s", 5);
  svc.upsertSegment(d, 1000, { segmentId: "s", version: 1, startMs: 0, endMs: 300 });

  deepEqual(svc.getProgress(a), { coveredMs: 500, completed: false });
  deepEqual(svc.getProgress(b), { coveredMs: 0, completed: false });
  deepEqual(svc.getProgress(c), { coveredMs: 0, completed: false });
  deepEqual(svc.getProgress(d), { coveredMs: 300, completed: false });
});

test("首尾相接的片段合并计算，无有效片段时覆盖为零", () => {
  const svc = createWatchCoverageService();
  const k = key("t1", "p1", "v1");
  deepEqual(svc.getProgress(k), { coveredMs: 0, completed: false });

  svc.upsertSegment(k, 1000, { segmentId: "a", version: 1, startMs: 0, endMs: 500 });
  svc.upsertSegment(k, 1000, { segmentId: "b", version: 1, startMs: 500, endMs: 1000 });
  deepEqual(svc.getProgress(k), { coveredMs: 1000, completed: true });
});
