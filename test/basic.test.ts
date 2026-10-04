import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { GatewayManager } from "../src/index";
import {
  makeSourcePackage,
  makeWorkDir,
  packagesByteEqual,
  readActiveRecord,
  removeDir,
} from "./helpers";

test("首次发布前没有运行中的包", async () => {
  const dir = makeWorkDir("ef-basic-");
  const mgr = await GatewayManager.open(dir);
  const status = mgr.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.generation, 0);
  assert.equal(status.currentReleaseId, null);
  assert.deepEqual(status.releases, []);
  // 生效记录已落盘且表示停止运行
  assert.deepEqual(readActiveRecord(dir), { state: "stopped", generation: 0 });
  mgr.close();
  removeDir(dir);
});

test("发布后生效记录指向完整包，源目录可立即删除", async () => {
  const dir = makeWorkDir("ef-basic-");
  const src = makeWorkDir("ef-src-");
  makeSourcePackage(src, { pipeline: { name: "p1" }, modelBytes: 4096, seed: 7 });

  const mgr = await GatewayManager.open(dir);
  const result = await mgr.publish("req-p1", src);
  assert.equal(result.duplicated, false);
  assert.equal(result.releaseId, 1);
  assert.equal(result.generation, 1);

  // 发布正常返回后立即删除源目录
  removeDir(src);

  const status = mgr.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.currentReleaseId, 1);
  assert.equal(status.releases.length, 1);

  const active = readActiveRecord(dir) as {
    state: string;
    generation: number;
    releaseId: number;
    dir: string;
  };
  assert.equal(active.state, "running");
  assert.equal(active.generation, 1);
  assert.equal(active.releaseId, 1);
  // 生效包与源包逐字节一致（源目录已删，与重新生成的同内容包比较）
  const srcAgain = makeWorkDir("ef-src-");
  makeSourcePackage(srcAgain, { pipeline: { name: "p1" }, modelBytes: 4096, seed: 7 });
  assert.ok(packagesByteEqual(active.dir, srcAgain));
  assert.ok(path.isAbsolute(active.dir));
  mgr.close();
  removeDir(dir);
  removeDir(srcAgain);
});

test("相同请求标识的发布重试返回首次结果，不重复创建发布", async () => {
  const dir = makeWorkDir("ef-basic-");
  const src = makeWorkDir("ef-src-");
  makeSourcePackage(src, { pipeline: { a: 1 }, modelBytes: 1024, seed: 3 });

  const mgr = await GatewayManager.open(dir);
  const first = await mgr.publish("req-dup", src);
  const second = await mgr.publish("req-dup", src);
  assert.equal(second.duplicated, true);
  assert.equal(second.releaseId, first.releaseId);
  assert.equal(second.generation, first.generation);
  assert.equal(mgr.getStatus().releases.length, 1);
  mgr.close();
  removeDir(dir);
  removeDir(src);
});

test("成功报告打断连续失败", async () => {
  const dir = makeWorkDir("ef-basic-");
  const srcA = makeWorkDir("ef-src-");
  const srcB = makeWorkDir("ef-src-");
  makeSourcePackage(srcA, { pipeline: { v: "A" }, modelBytes: 512, seed: 1 });
  makeSourcePackage(srcB, { pipeline: { v: "B" }, modelBytes: 512, seed: 2 });

  const mgr = await GatewayManager.open(dir);
  await mgr.publish("pA", srcA);
  const pubB = await mgr.publish("pB", srcB);
  const gen = pubB.generation;

  let r = await mgr.reportInference("f1", { generation: gen, timestampMs: 1000, success: false });
  assert.deepEqual([r.applied, r.rolledBack], [true, false]);
  r = await mgr.reportInference("f2", { generation: gen, timestampMs: 2000, success: false });
  assert.equal(r.rolledBack, false);
  // 成功打断
  r = await mgr.reportInference("ok1", { generation: gen, timestampMs: 3000, success: true });
  assert.deepEqual([r.applied, r.rolledBack], [true, false]);
  r = await mgr.reportInference("f3", { generation: gen, timestampMs: 4000, success: false });
  assert.equal(r.rolledBack, false);
  r = await mgr.reportInference("f4", { generation: gen, timestampMs: 5000, success: false });
  assert.equal(r.rolledBack, false);
  // 连续失败被成功打断，未触发回退
  assert.equal(mgr.getStatus().currentReleaseId, 2);
  mgr.close();
  removeDir(dir);
  removeDir(srcA);
  removeDir(srcB);
});

test("连续3次失败且首尾时间差恰好300000ms触发回退", async () => {
  const dir = makeWorkDir("ef-basic-");
  const srcA = makeWorkDir("ef-src-");
  const srcB = makeWorkDir("ef-src-");
  makeSourcePackage(srcA, { pipeline: { v: "A" }, modelBytes: 512, seed: 11 });
  makeSourcePackage(srcB, { pipeline: { v: "B" }, modelBytes: 512, seed: 22 });

  const mgr = await GatewayManager.open(dir);
  await mgr.publish("pA", srcA);
  const pubB = await mgr.publish("pB", srcB);
  const gen = pubB.generation;

  await mgr.reportInference("f1", { generation: gen, timestampMs: 100000, success: false });
  await mgr.reportInference("f2", { generation: gen, timestampMs: 250000, success: false });
  const r = await mgr.reportInference("f3", {
    generation: gen,
    timestampMs: 400000, // 400000 - 100000 = 300000，恰好触发
    success: false,
  });
  assert.equal(r.applied, true);
  assert.equal(r.rolledBack, true);

  const status = mgr.getStatus();
  assert.equal(status.currentReleaseId, 1); // 回退到 A
  assert.equal(status.generation, gen + 1); // 回退也产生新运行代次
  assert.equal(status.releases.find((x) => x.id === 2)?.eliminated, true);
  assert.equal(status.releases.find((x) => x.id === 1)?.eliminated, false);
  const active = readActiveRecord(dir) as { state: string; releaseId: number; generation: number };
  assert.equal(active.state, "running");
  assert.equal(active.releaseId, 1);
  assert.equal(active.generation, gen + 1);
  mgr.close();
  removeDir(dir);
  removeDir(srcA);
  removeDir(srcB);
});

test("连续3次失败但首尾时间差超过300000ms不触发回退", async () => {
  const dir = makeWorkDir("ef-basic-");
  const srcA = makeWorkDir("ef-src-");
  const srcB = makeWorkDir("ef-src-");
  makeSourcePackage(srcA, { pipeline: { v: "A" }, modelBytes: 512, seed: 1 });
  makeSourcePackage(srcB, { pipeline: { v: "B" }, modelBytes: 512, seed: 2 });

  const mgr = await GatewayManager.open(dir);
  await mgr.publish("pA", srcA);
  const pubB = await mgr.publish("pB", srcB);
  const gen = pubB.generation;

  await mgr.reportInference("f1", { generation: gen, timestampMs: 1000, success: false });
  await mgr.reportInference("f2", { generation: gen, timestampMs: 2000, success: false });
  const r = await mgr.reportInference("f3", {
    generation: gen,
    timestampMs: 2000 + 300001, // 首尾差 300001ms
    success: false,
  });
  assert.equal(r.rolledBack, false);
  assert.equal(mgr.getStatus().currentReleaseId, 2);
  mgr.close();
  removeDir(dir);
  removeDir(srcA);
  removeDir(srcB);
});

test("重复报告不重复累加失败、不重复回退", async () => {
  const dir = makeWorkDir("ef-basic-");
  const srcA = makeWorkDir("ef-src-");
  const srcB = makeWorkDir("ef-src-");
  makeSourcePackage(srcA, { pipeline: { v: "A" }, modelBytes: 512, seed: 1 });
  makeSourcePackage(srcB, { pipeline: { v: "B" }, modelBytes: 512, seed: 2 });

  const mgr = await GatewayManager.open(dir);
  await mgr.publish("pA", srcA);
  const pubB = await mgr.publish("pB", srcB);
  const gen = pubB.generation;

  // 同一个失败报告重复提交 3 次，只应累计一次
  for (let i = 0; i < 3; i++) {
    const r = await mgr.reportInference("f1", { generation: gen, timestampMs: 1000, success: false });
    if (i === 0) assert.equal(r.duplicated, false);
    else assert.equal(r.duplicated, true);
    assert.equal(r.rolledBack, false);
  }
  // 再补两次不同的失败才触发回退
  await mgr.reportInference("f2", { generation: gen, timestampMs: 2000, success: false });
  const r = await mgr.reportInference("f3", { generation: gen, timestampMs: 3000, success: false });
  assert.equal(r.rolledBack, true);
  // 重复提交触发回退的那次报告：返回首次结果，不再次回退
  const dup = await mgr.reportInference("f3", { generation: gen, timestampMs: 3000, success: false });
  assert.equal(dup.duplicated, true);
  assert.equal(dup.rolledBack, true);
  const status = mgr.getStatus();
  assert.equal(status.currentReleaseId, 1);
  assert.equal(status.generation, gen + 1);
  mgr.close();
  removeDir(dir);
  removeDir(srcA);
  removeDir(srcB);
});

test("回退后迟到的旧代次报告不影响当前状态", async () => {
  const dir = makeWorkDir("ef-basic-");
  const srcA = makeWorkDir("ef-src-");
  const srcB = makeWorkDir("ef-src-");
  makeSourcePackage(srcA, { pipeline: { v: "A" }, modelBytes: 512, seed: 1 });
  makeSourcePackage(srcB, { pipeline: { v: "B" }, modelBytes: 512, seed: 2 });

  const mgr = await GatewayManager.open(dir);
  await mgr.publish("pA", srcA);
  const pubB = await mgr.publish("pB", srcB);
  const genB = pubB.generation;

  await mgr.reportInference("f1", { generation: genB, timestampMs: 1000, success: false });
  await mgr.reportInference("f2", { generation: genB, timestampMs: 2000, success: false });
  await mgr.reportInference("f3", { generation: genB, timestampMs: 3000, success: false });
  const genA = mgr.getStatus().generation; // 已回退到 A 的新代次

  // 旧代次（B 的代次）的失败报告迟到：不应累计到 A 的代次上
  const late1 = await mgr.reportInference("late1", {
    generation: genB,
    timestampMs: 4000,
    success: false,
  });
  assert.equal(late1.applied, false);
  assert.equal(late1.rolledBack, false);
  const late2 = await mgr.reportInference("late2", {
    generation: genB,
    timestampMs: 5000,
    success: false,
  });
  assert.equal(late2.applied, false);

  // A 的代次未被污染：需要完整的 3 次失败才会再次回退
  await mgr.reportInference("g1", { generation: genA, timestampMs: 6000, success: false });
  await mgr.reportInference("g2", { generation: genA, timestampMs: 7000, success: false });
  const notYet = mgr.getStatus();
  assert.equal(notYet.currentReleaseId, 1);
  assert.equal(notYet.running, true);
  const r = await mgr.reportInference("g3", { generation: genA, timestampMs: 8000, success: false });
  assert.equal(r.rolledBack, true);
  // A 之前没有更早的发布：停止运行
  const final = mgr.getStatus();
  assert.equal(final.running, false);
  assert.equal(final.currentReleaseId, null);
  assert.deepEqual(readActiveRecord(dir), { state: "stopped", generation: genA + 1 });
  mgr.close();
  removeDir(dir);
  removeDir(srcA);
  removeDir(srcB);
});

test("模型超过100MB拒绝发布", async () => {
  const dir = makeWorkDir("ef-basic-");
  const src = makeWorkDir("ef-src-");
  makeSourcePackage(src, { pipeline: { v: "big" }, modelBytes: 100 * 1024 * 1024 + 1, seed: 1 });

  const mgr = await GatewayManager.open(dir);
  await assert.rejects(mgr.publish("p-big", src), /100MB/);
  assert.equal(mgr.getStatus().releases.length, 0);
  assert.equal(mgr.getStatus().running, false);
  mgr.close();
  removeDir(dir);
  removeDir(src);
});

test("重启不清空连续失败证据", async () => {
  const dir = makeWorkDir("ef-basic-");
  const srcA = makeWorkDir("ef-src-");
  const srcB = makeWorkDir("ef-src-");
  makeSourcePackage(srcA, { pipeline: { v: "A" }, modelBytes: 512, seed: 1 });
  makeSourcePackage(srcB, { pipeline: { v: "B" }, modelBytes: 512, seed: 2 });

  let mgr = await GatewayManager.open(dir);
  await mgr.publish("pA", srcA);
  const pubB = await mgr.publish("pB", srcB);
  const gen = pubB.generation;
  await mgr.reportInference("f1", { generation: gen, timestampMs: 1000, success: false });
  await mgr.reportInference("f2", { generation: gen, timestampMs: 2000, success: false });
  mgr.close();

  // 重启后续上第 3 次失败，仍应触发回退
  mgr = await GatewayManager.open(dir);
  const r = await mgr.reportInference("f3", { generation: gen, timestampMs: 3000, success: false });
  assert.equal(r.rolledBack, true);
  assert.equal(mgr.getStatus().currentReleaseId, 1);
  mgr.close();
  removeDir(dir);
  removeDir(srcA);
  removeDir(srcB);
});
