import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { GatewayManager } from "../src/manager";
import type { GatewayStatus } from "../src/types";
import { assertDirsEqual, freshDir, makePackage, readPointer } from "./helpers";

test("数据目录不存在时自动创建，初始状态为停止运行", () => {
  const dataDir = path.join(freshDir("edgeforge-parent-"), "nested", "data");
  const manager = new GatewayManager(dataDir);
  const status = manager.recover();
  assert.equal(status.running, false);
  assert.equal(status.generation, 0);
  assert.equal(status.releases.length, 0);
  manager.close();
});

function publish(manager: GatewayManager, requestId: string, sourceDir: string) {
  return manager.publish({ requestId, sourceDir });
}

function fail(manager: GatewayManager, requestId: string, generation: number, timestamp: number) {
  return manager.reportInference({ requestId, generation, timestamp, success: false });
}

test("发布后可删除源目录，生效记录指向完整包", () => {
  const dataDir = freshDir("edgeforge-data-");
  const manager = new GatewayManager(dataDir);

  const src = makePackage("A", 1024 * 1024);
  const snapshot = freshDir("edgeforge-snap-");
  fs.cpSync(src, snapshot, { recursive: true });

  const result = publish(manager, "pub-1", src);
  assert.equal(result.releaseId, 1);
  assert.equal(result.generation, 1);
  assert.equal(result.duplicate, false);

  fs.rmSync(src, { recursive: true, force: true });

  const status = manager.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.currentReleaseId, 1);
  assert.equal(status.releases.length, 1);

  const pointer = readPointer(dataDir);
  assert.deepEqual(pointer, { generation: 1, releaseId: 1 });
  assertDirsEqual(path.join(dataDir, "releases", "1"), snapshot);
  manager.close();
});

test("相同请求标识的发布重试返回首次结果，不重复创建发布", () => {
  const dataDir = freshDir("edgeforge-data-");
  const manager = new GatewayManager(dataDir);
  const src = makePackage("A", 1024);

  const first = publish(manager, "pub-dup", src);
  const retry = publish(manager, "pub-dup", src);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.releaseId, first.releaseId);
  assert.equal(retry.generation, first.generation);
  assert.equal(manager.getStatus().releases.length, 1);
  manager.close();
});

test("相同内容的重复发布会产生独立记录并重新尝试", () => {
  const dataDir = freshDir("edgeforge-data-");
  const manager = new GatewayManager(dataDir);
  const src = makePackage("A", 1024);

  publish(manager, "pub-a1", src);
  fail(manager, "f1", 1, 1000);
  fail(manager, "f2", 1, 2000);
  const rollback = fail(manager, "f3", 1, 3000);
  assert.equal(rollback.rollback?.targetReleaseId, null);
  assert.equal(manager.getStatus().running, false);

  const again = publish(manager, "pub-a2", src);
  assert.equal(again.releaseId, 2);
  const status = manager.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.currentReleaseId, 2);
  assert.equal(status.releases.length, 2);
  manager.close();
});

test("时间差恰好 300000ms 仍触发回退", () => {
  const dataDir = freshDir("edgeforge-data-");
  const manager = new GatewayManager(dataDir);
  publish(manager, "pub-a", makePackage("A", 512));
  publish(manager, "pub-b", makePackage("B", 512));

  fail(manager, "f1", 2, 100000);
  fail(manager, "f2", 2, 250000);
  const third = fail(manager, "f3", 2, 400000);
  assert.equal(third.rollback?.eliminatedReleaseId, 2);
  assert.equal(third.rollback?.targetReleaseId, 1);
  assert.equal(manager.getStatus().currentReleaseId, 1);
  manager.close();
});

test("时间差超过 300000ms 不触发回退", () => {
  const dataDir = freshDir("edgeforge-data-");
  const manager = new GatewayManager(dataDir);
  publish(manager, "pub-a", makePackage("A", 512));

  fail(manager, "f1", 1, 100000);
  fail(manager, "f2", 1, 200000);
  const third = fail(manager, "f3", 1, 400001);
  assert.equal(third.rollback, null);
  assert.equal(manager.getStatus().currentReleaseId, 1);
  manager.close();
});

test("成功报告打断连续失败", () => {
  const dataDir = freshDir("edgeforge-data-");
  const manager = new GatewayManager(dataDir);
  publish(manager, "pub-a", makePackage("A", 512));

  fail(manager, "f1", 1, 1000);
  fail(manager, "f2", 1, 2000);
  manager.reportInference({ requestId: "ok1", generation: 1, timestamp: 3000, success: true });
  fail(manager, "f3", 1, 4000);
  const fourth = fail(manager, "f4", 1, 5000);
  assert.equal(fourth.rollback, null);
  const fifth = fail(manager, "f5", 1, 6000);
  assert.notEqual(fifth.rollback, null);
  manager.close();
});

test("重复报告返回首次结果，不累加失败、不重复回退", () => {
  const dataDir = freshDir("edgeforge-data-");
  const manager = new GatewayManager(dataDir);
  publish(manager, "pub-a", makePackage("A", 512));
  publish(manager, "pub-b", makePackage("B", 512));

  fail(manager, "f1", 2, 1000);
  fail(manager, "f2", 2, 2000);
  const third = fail(manager, "f3", 2, 3000);
  assert.notEqual(third.rollback, null);

  const retry = fail(manager, "f3", 2, 3000);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.rollback, third.rollback);

  const status = manager.getStatus();
  assert.equal(status.currentReleaseId, 1);
  assert.equal(status.generation, 3);
  assert.equal(status.releases.filter((r) => r.eliminated).length, 1);
  manager.close();
});

test("回退后迟到的旧代次报告不影响当前状态", () => {
  const dataDir = freshDir("edgeforge-data-");
  const manager = new GatewayManager(dataDir);
  publish(manager, "pub-a", makePackage("A", 512));
  publish(manager, "pub-b", makePackage("B", 512));

  fail(manager, "f1", 2, 1000);
  fail(manager, "f2", 2, 2000);
  fail(manager, "f3", 2, 3000);
  assert.equal(manager.getStatus().currentReleaseId, 1);

  const late = fail(manager, "late-1", 2, 4000);
  assert.equal(late.accepted, false);
  assert.equal(late.rollback, null);

  fail(manager, "g1", 3, 5000);
  fail(manager, "g2", 3, 6000);
  const lateAgain = fail(manager, "late-2", 2, 6500);
  assert.equal(lateAgain.accepted, false);
  const beforeStop = fail(manager, "g3", 3, 7000);
  assert.equal(beforeStop.rollback?.targetReleaseId, null);
  manager.close();
});

test("重启不清空连续失败证据，新代次重新累计", () => {
  const dataDir = freshDir("edgeforge-data-");
  let manager = new GatewayManager(dataDir);
  publish(manager, "pub-a", makePackage("A", 512));
  publish(manager, "pub-b", makePackage("B", 512));

  fail(manager, "f1", 2, 1000);
  fail(manager, "f2", 2, 2000);
  manager.close();

  manager = new GatewayManager(dataDir);
  manager.recover();
  const third = fail(manager, "f3", 2, 3000);
  assert.notEqual(third.rollback, null);
  assert.equal(manager.getStatus().currentReleaseId, 1);

  fail(manager, "g1", 3, 4000);
  fail(manager, "g2", 3, 5000);
  manager.close();

  manager = new GatewayManager(dataDir);
  manager.recover();
  const sixth = fail(manager, "g3", 3, 6000);
  assert.notEqual(sixth.rollback, null);
  assert.equal(manager.getStatus().running, false);
  manager.close();
});

/** 依次发布 A、B、C 后连续故障：C→B→A→停止。可穿插重启。 */
function runAbCSequence(dataDir: string, restartEveryStep: boolean): GatewayStatus {
  let manager = new GatewayManager(dataDir);
  const reopen = () => {
    if (restartEveryStep) {
      manager.close();
      manager = new GatewayManager(dataDir);
      manager.recover();
    }
  };

  publish(manager, "pub-a", makePackage("A", 512));
  reopen();
  publish(manager, "pub-b", makePackage("B", 512));
  reopen();
  publish(manager, "pub-c", makePackage("C", 512));
  reopen();

  let generation = 3;
  let clock = 0;
  const failTriple = (tag: string) => {
    for (let i = 0; i < 3; i += 1) {
      clock += 1000;
      const result = fail(manager, `${tag}-${i}`, generation, clock);
      reopen();
      if (i === 2) {
        generation = result.rollback?.generation ?? generation;
      }
    }
  };

  failTriple("c");
  assert.equal(manager.getStatus().currentReleaseId, 2);
  failTriple("b");
  assert.equal(manager.getStatus().currentReleaseId, 1);
  failTriple("a");
  const status = manager.getStatus();
  manager.close();
  return status;
}

test("A、B、C 连续故障退至 B、再退至 A、最终停止，穿插重启结果一致", () => {
  const smooth = runAbCSequence(freshDir("edgeforge-data-"), false);
  const restarted = runAbCSequence(freshDir("edgeforge-data-"), true);

  assert.equal(smooth.running, false);
  assert.equal(smooth.currentReleaseId, null);
  assert.deepEqual(
    smooth.releases.map((r) => ({ releaseId: r.releaseId, eliminated: r.eliminated })),
    [
      { releaseId: 1, eliminated: true },
      { releaseId: 2, eliminated: true },
      { releaseId: 3, eliminated: true },
    ],
  );
  assert.deepEqual(
    restarted.releases.map((r) => ({ releaseId: r.releaseId, eliminated: r.eliminated })),
    smooth.releases.map((r) => ({ releaseId: r.releaseId, eliminated: r.eliminated })),
  );
  assert.equal(restarted.generation, smooth.generation);
  assert.equal(restarted.running, smooth.running);
});
