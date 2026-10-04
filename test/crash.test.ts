import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { GatewayManager } from "../src/index";
import {
  makeSourcePackage,
  makeWorkDir,
  packagesByteEqual,
  readActiveRecord,
  removeDir,
  runWorker,
} from "./helpers";

const PUBLISH_CRASH_POINTS = [
  "publish.afterStage",
  "publish.afterCommitDir",
  "publish.afterDbCommit",
  "publish.afterActiveWrite",
];

for (const point of PUBLISH_CRASH_POINTS) {
  test(`发布在 ${point} 崩溃：恢复重试后发布效果唯一、包逐字节完整`, async () => {
    const dir = makeWorkDir("ef-crash-");
    const src = makeWorkDir("ef-src-");
    const spec = { pipeline: { name: "p", point }, modelBytes: 8192, seed: 99 };
    makeSourcePackage(src, spec);

    // 子进程在指定边界崩溃
    const crashed = runWorker(dir, [{ type: "publish", requestId: "req-1", sourceDir: src }], point);
    assert.equal(crashed.status, 43, crashed.stderr);

    // 新进程恢复后按原请求标识重试
    const mgr = await GatewayManager.open(dir);
    const result = await mgr.publish("req-1", src);

    // 不管崩在哪个边界，最终都只有一次发布效果
    assert.equal(result.releaseId, 1);
    assert.equal(result.generation, 1);
    const status = mgr.getStatus();
    assert.equal(status.releases.length, 1);
    assert.equal(status.running, true);
    assert.equal(status.currentReleaseId, 1);
    assert.equal(status.generation, 1);

    // 生效记录指向完整可读的同一发布包，且与源包逐字节一致
    const active = readActiveRecord(dir) as { state: string; releaseId: number; dir: string };
    assert.equal(active.state, "running");
    assert.equal(active.releaseId, 1);
    assert.ok(packagesByteEqual(active.dir, src));

    // 不留下半次发布的痕迹：无 staging、无孤儿目录
    assert.ok(!fs.existsSync(path.join(dir, "staging")));
    assert.deepEqual(fs.readdirSync(path.join(dir, "releases")), ["1"]);

    mgr.close();
    removeDir(dir);
    removeDir(src);
  });
}

test("回退在 report.afterDbCommit 崩溃：恢复后生效记录与真源一致，重试不重复回退", async () => {
  const dir = makeWorkDir("ef-crash-");
  const srcA = makeWorkDir("ef-src-");
  const srcB = makeWorkDir("ef-src-");
  makeSourcePackage(srcA, { pipeline: { v: "A" }, modelBytes: 4096, seed: 1 });
  makeSourcePackage(srcB, { pipeline: { v: "B" }, modelBytes: 4096, seed: 2 });

  // 子进程：发布 A、B，然后连续 3 次失败；在第 3 次报告提交后、生效记录切换前崩溃
  const crashed = runWorker(
    dir,
    [
      { type: "publish", requestId: "pA", sourceDir: srcA },
      { type: "publish", requestId: "pB", sourceDir: srcB },
      { type: "report", requestId: "f1", report: { generation: 2, timestampMs: 1000, success: false } },
      { type: "report", requestId: "f2", report: { generation: 2, timestampMs: 2000, success: false } },
      { type: "report", requestId: "f3", report: { generation: 2, timestampMs: 3000, success: false } },
    ],
    "report.afterDbCommit@3"
  );
  assert.equal(crashed.status, 43, crashed.stderr);

  // 崩溃瞬间 active.json 仍指向 B（旧代次），恢复必须以 SQLite 真源重写为 A
  const mgr = await GatewayManager.open(dir);
  const status = mgr.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.currentReleaseId, 1);
  assert.equal(status.generation, 3);
  assert.equal(status.releases.find((r) => r.id === 2)?.eliminated, true);
  const active = readActiveRecord(dir) as { state: string; releaseId: number; generation: number; dir: string };
  assert.deepEqual([active.state, active.releaseId, active.generation], ["running", 1, 3]);
  assert.ok(packagesByteEqual(active.dir, srcA));

  // 重试触发回退的那次报告：返回首次结果，不得再次回退
  const dup = await mgr.reportInference("f3", { generation: 2, timestampMs: 3000, success: false });
  assert.equal(dup.duplicated, true);
  assert.equal(dup.rolledBack, true);
  const after = mgr.getStatus();
  assert.equal(after.currentReleaseId, 1);
  assert.equal(after.generation, 3);

  // 淘汰历史未丢失：A 再连续失败 3 次后停止运行（不会切回 B）
  await mgr.reportInference("g1", { generation: 3, timestampMs: 4000, success: false });
  await mgr.reportInference("g2", { generation: 3, timestampMs: 5000, success: false });
  const r = await mgr.reportInference("g3", { generation: 3, timestampMs: 6000, success: false });
  assert.equal(r.rolledBack, true);
  const final = mgr.getStatus();
  assert.equal(final.running, false);
  assert.equal(final.currentReleaseId, null);
  assert.deepEqual(readActiveRecord(dir), { state: "stopped", generation: 4 });

  mgr.close();
  removeDir(dir);
  removeDir(srcA);
  removeDir(srcB);
});

test("回退在 report.afterActiveWrite 崩溃：恢复后状态不变，重试幂等", async () => {
  const dir = makeWorkDir("ef-crash-");
  const srcA = makeWorkDir("ef-src-");
  const srcB = makeWorkDir("ef-src-");
  makeSourcePackage(srcA, { pipeline: { v: "A" }, modelBytes: 4096, seed: 1 });
  makeSourcePackage(srcB, { pipeline: { v: "B" }, modelBytes: 4096, seed: 2 });

  const crashed = runWorker(
    dir,
    [
      { type: "publish", requestId: "pA", sourceDir: srcA },
      { type: "publish", requestId: "pB", sourceDir: srcB },
      { type: "report", requestId: "f1", report: { generation: 2, timestampMs: 1000, success: false } },
      { type: "report", requestId: "f2", report: { generation: 2, timestampMs: 2000, success: false } },
      { type: "report", requestId: "f3", report: { generation: 2, timestampMs: 3000, success: false } },
    ],
    "report.afterActiveWrite@1"
  );
  assert.equal(crashed.status, 43, crashed.stderr);

  const mgr = await GatewayManager.open(dir);
  const status = mgr.getStatus();
  assert.equal(status.currentReleaseId, 1);
  assert.equal(status.generation, 3);
  const dup = await mgr.reportInference("f3", { generation: 2, timestampMs: 3000, success: false });
  assert.equal(dup.duplicated, true);
  assert.equal(mgr.getStatus().generation, 3);
  mgr.close();
  removeDir(dir);
  removeDir(srcA);
  removeDir(srcB);
});

test("失败证据在 SQLite 提交边界崩溃：重启后证据不丢、不重复累计", async () => {
  const dir = makeWorkDir("ef-crash-");
  const srcA = makeWorkDir("ef-src-");
  const srcB = makeWorkDir("ef-src-");
  makeSourcePackage(srcA, { pipeline: { v: "A" }, modelBytes: 512, seed: 1 });
  makeSourcePackage(srcB, { pipeline: { v: "B" }, modelBytes: 512, seed: 2 });

  // 第 2 次失败报告在提交后立刻崩溃
  const crashed = runWorker(
    dir,
    [
      { type: "publish", requestId: "pA", sourceDir: srcA },
      { type: "publish", requestId: "pB", sourceDir: srcB },
      { type: "report", requestId: "f1", report: { generation: 2, timestampMs: 1000, success: false } },
      { type: "report", requestId: "f2", report: { generation: 2, timestampMs: 2000, success: false } },
    ],
    "report.afterDbCommit@2"
  );
  assert.equal(crashed.status, 43, crashed.stderr);

  const mgr = await GatewayManager.open(dir);
  // 重试 f2：幂等返回，不重复累计（否则 f2 重试 + f3 就会凑够 3 次）
  const dup = await mgr.reportInference("f2", { generation: 2, timestampMs: 2000, success: false });
  assert.equal(dup.duplicated, true);
  assert.equal(dup.rolledBack, false);
  assert.equal(mgr.getStatus().currentReleaseId, 2);
  // 第 3 次失败触发回退
  const r = await mgr.reportInference("f3", { generation: 2, timestampMs: 3000, success: false });
  assert.equal(r.rolledBack, true);
  assert.equal(mgr.getStatus().currentReleaseId, 1);
  mgr.close();
  removeDir(dir);
  removeDir(srcA);
  removeDir(srcB);
});

test("崩溃后恢复不要求重新提供已成功发布的源包", async () => {
  const dir = makeWorkDir("ef-crash-");
  const srcA = makeWorkDir("ef-src-");
  const srcB = makeWorkDir("ef-src-");
  makeSourcePackage(srcA, { pipeline: { v: "A" }, modelBytes: 4096, seed: 5 });
  makeSourcePackage(srcB, { pipeline: { v: "B" }, modelBytes: 4096, seed: 6 });

  // B 发布在生效记录写入前崩溃；A 早已成功发布且源目录已删除
  const crashed = runWorker(
    dir,
    [
      { type: "publish", requestId: "pA", sourceDir: srcA },
      { type: "publish", requestId: "pB", sourceDir: srcB },
    ],
    "publish.afterDbCommit@2"
  );
  assert.equal(crashed.status, 43, crashed.stderr);
  removeDir(srcA);
  removeDir(srcB);

  // 恢复：A 的包仍完整可用；随后 B 连续失败 3 次能回退到 A，全程不需要源包
  const mgr = await GatewayManager.open(dir);
  assert.equal(mgr.getStatus().currentReleaseId, 2);
  await mgr.reportInference("f1", { generation: 2, timestampMs: 1000, success: false });
  await mgr.reportInference("f2", { generation: 2, timestampMs: 2000, success: false });
  const r = await mgr.reportInference("f3", { generation: 2, timestampMs: 3000, success: false });
  assert.equal(r.rolledBack, true);
  const status = mgr.getStatus();
  assert.equal(status.currentReleaseId, 1);
  const active = readActiveRecord(dir) as { dir: string };
  // 回退后的生效包逐字节完整（与重新生成的同内容 A 比较）
  const srcA2 = makeWorkDir("ef-src-");
  makeSourcePackage(srcA2, { pipeline: { v: "A" }, modelBytes: 4096, seed: 5 });
  assert.ok(packagesByteEqual(active.dir, srcA2));
  mgr.close();
  removeDir(dir);
  removeDir(srcA2);
});
