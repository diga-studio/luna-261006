import assert from "node:assert/strict";
import test from "node:test";
import { GatewayManager, GatewayStatus } from "../src/index";
import {
  makeSourcePackage,
  makeWorkDir,
  readActiveRecord,
  removeDir,
  runWorker,
} from "./helpers";

interface Spec {
  pipeline: unknown;
  modelBytes: number;
  seed: number;
}

const SPECS: Spec[] = [
  { pipeline: { v: "A" }, modelBytes: 2048, seed: 101 },
  { pipeline: { v: "B" }, modelBytes: 2048, seed: 102 },
  { pipeline: { v: "C" }, modelBytes: 2048, seed: 103 },
];

/** 状态快照的可比较投影。 */
function project(s: GatewayStatus): unknown {
  return {
    running: s.running,
    generation: s.generation,
    currentReleaseId: s.currentReleaseId,
    releases: s.releases.map((r) => ({ id: r.id, eliminated: r.eliminated })),
  };
}

/** 依次发布 A、B、C，然后 C、B、A 各连续失败 3 次直至停止。返回每步后的状态快照。 */
async function runChain(dir: string, srcs: string[], reopenBetweenOps: boolean): Promise<unknown[]> {
  let mgr = await GatewayManager.open(dir);
  const snapshots: unknown[] = [];
  const ops: Array<() => Promise<unknown>> = [
    () => mgr.publish("pA", srcs[0]),
    () => mgr.publish("pB", srcs[1]),
    () => mgr.publish("pC", srcs[2]),
    // C 连续失败（gen 3）→ 回退到 B
    () => mgr.reportInference("c1", { generation: 3, timestampMs: 1000, success: false }),
    () => mgr.reportInference("c2", { generation: 3, timestampMs: 2000, success: false }),
    () => mgr.reportInference("c3", { generation: 3, timestampMs: 3000, success: false }),
    // B 连续失败（gen 4）→ 回退到 A
    () => mgr.reportInference("b1", { generation: 4, timestampMs: 4000, success: false }),
    () => mgr.reportInference("b2", { generation: 4, timestampMs: 5000, success: false }),
    () => mgr.reportInference("b3", { generation: 4, timestampMs: 6000, success: false }),
    // A 连续失败（gen 5）→ 无候选，停止运行
    () => mgr.reportInference("a1", { generation: 5, timestampMs: 7000, success: false }),
    () => mgr.reportInference("a2", { generation: 5, timestampMs: 8000, success: false }),
    () => mgr.reportInference("a3", { generation: 5, timestampMs: 9000, success: false }),
  ];
  for (const op of ops) {
    await op();
    snapshots.push(project(mgr.getStatus()));
    if (reopenBetweenOps) {
      mgr.close();
      mgr = await GatewayManager.open(dir);
    }
  }
  mgr.close();
  return snapshots;
}

test("A→B→C 连续故障逐级回退至停止：穿插重启与无中断结果一致", async () => {
  // 参考运行：无中断
  const dirRef = makeWorkDir("ef-scn-");
  const srcsRef = [makeWorkDir("ef-src-"), makeWorkDir("ef-src-"), makeWorkDir("ef-src-")];
  SPECS.forEach((s, i) => makeSourcePackage(srcsRef[i], s));
  const refSnapshots = await runChain(dirRef, srcsRef, false);
  const refActive = readActiveRecord(dirRef);

  // 对照运行：每个操作之间都关闭并重新打开（触发恢复）
  const dirRst = makeWorkDir("ef-scn-");
  const srcsRst = [makeWorkDir("ef-src-"), makeWorkDir("ef-src-"), makeWorkDir("ef-src-")];
  SPECS.forEach((s, i) => makeSourcePackage(srcsRst[i], s));
  const rstSnapshots = await runChain(dirRst, srcsRst, true);
  const rstActive = readActiveRecord(dirRst);

  assert.deepEqual(rstSnapshots, refSnapshots);
  assert.deepEqual(rstActive, refActive);

  // 关键轨迹校验：逐步回退、不在故障版本间来回切换、最终停止
  const finalSnap = refSnapshots[refSnapshots.length - 1] as {
    running: boolean;
    generation: number;
    currentReleaseId: number | null;
    releases: { id: number; eliminated: boolean }[];
  };
  assert.equal(finalSnap.running, false);
  assert.equal(finalSnap.generation, 6);
  assert.equal(finalSnap.currentReleaseId, null);
  assert.deepEqual(finalSnap.releases, [
    { id: 1, eliminated: true },
    { id: 2, eliminated: true },
    { id: 3, eliminated: true },
  ]);
  assert.deepEqual(refActive, { state: "stopped", generation: 6 });

  for (const d of [dirRef, dirRst, ...srcsRef, ...srcsRst]) removeDir(d);
});

test("A→B→C 场景在回退提交边界崩溃：恢复后与无中断结果一致", async () => {
  // 参考运行：无中断
  const dirRef = makeWorkDir("ef-scn-");
  const srcsRef = [makeWorkDir("ef-src-"), makeWorkDir("ef-src-"), makeWorkDir("ef-src-")];
  SPECS.forEach((s, i) => makeSourcePackage(srcsRef[i], s));
  const refSnapshots = await runChain(dirRef, srcsRef, false);
  const refActive = readActiveRecord(dirRef);

  // 崩溃运行：每次回退都在 SQLite 提交后、生效记录切换前崩溃
  const dir = makeWorkDir("ef-scn-");
  const srcs = [makeWorkDir("ef-src-"), makeWorkDir("ef-src-"), makeWorkDir("ef-src-")];
  SPECS.forEach((s, i) => makeSourcePackage(srcs[i], s));

  // 段 1：发布 A、B、C，C 的前两次失败
  let r = runWorker(
    dir,
    [
      { type: "publish", requestId: "pA", sourceDir: srcs[0] },
      { type: "publish", requestId: "pB", sourceDir: srcs[1] },
      { type: "publish", requestId: "pC", sourceDir: srcs[2] },
      { type: "report", requestId: "c1", report: { generation: 3, timestampMs: 1000, success: false } },
      { type: "report", requestId: "c2", report: { generation: 3, timestampMs: 2000, success: false } },
    ],
    ""
  );
  assert.equal(r.status, 0, r.stderr);

  // 段 2：C 的第 3 次失败，回退到 B 的事务提交后立刻崩溃
  r = runWorker(
    dir,
    [{ type: "report", requestId: "c3", report: { generation: 3, timestampMs: 3000, success: false } }],
    "report.afterDbCommit@1"
  );
  assert.equal(r.status, 43, r.stderr);

  // 段 3：恢复后 B 的前两次失败 + 第 3 次失败，回退到 A 提交后崩溃
  r = runWorker(
    dir,
    [
      { type: "report", requestId: "b1", report: { generation: 4, timestampMs: 4000, success: false } },
      { type: "report", requestId: "b2", report: { generation: 4, timestampMs: 5000, success: false } },
      { type: "report", requestId: "b3", report: { generation: 4, timestampMs: 6000, success: false } },
    ],
    "report.afterDbCommit@3"
  );
  assert.equal(r.status, 43, r.stderr);

  // 段 4：恢复后 A 的三次失败，停止运行的生效记录写完后崩溃
  r = runWorker(
    dir,
    [
      { type: "report", requestId: "a1", report: { generation: 5, timestampMs: 7000, success: false } },
      { type: "report", requestId: "a2", report: { generation: 5, timestampMs: 8000, success: false } },
      { type: "report", requestId: "a3", report: { generation: 5, timestampMs: 9000, success: false } },
    ],
    "report.afterActiveWrite@1"
  );
  assert.equal(r.status, 43, r.stderr);

  // 最终恢复：结果须与无中断运行一致
  const mgr = await GatewayManager.open(dir);
  const finalStatus = project(mgr.getStatus());
  const refFinal = refSnapshots[refSnapshots.length - 1];
  assert.deepEqual(finalStatus, refFinal);
  assert.deepEqual(readActiveRecord(dir), refActive);

  // 崩溃时未返回的回退报告按原请求标识重试：幂等，不产生第二次业务效果
  const dup = await mgr.reportInference("a3", { generation: 5, timestampMs: 9000, success: false });
  assert.equal(dup.duplicated, true);
  assert.deepEqual(project(mgr.getStatus()), refFinal);

  mgr.close();
  for (const d of [dirRef, dir, ...srcsRef, ...srcs]) removeDir(d);
});
