import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { GatewayManager } from "../src/manager";
import type { GatewayStatus, PublishResult, ReportResult } from "../src/types";
import { assertDirsEqual, freshDir, makePackage, readPointer, runDriver } from "./helpers";

function snapshotOf(dir: string): string {
  const snapshot = freshDir("edgeforge-snap-");
  fs.cpSync(dir, snapshot, { recursive: true });
  return snapshot;
}

function assertConsistent(dataDir: string, status: GatewayStatus): void {
  const pointer = readPointer(dataDir);
  assert.equal(pointer.generation, status.generation, "生效记录代次应与当前状态一致");
  assert.equal(pointer.releaseId, status.currentReleaseId, "生效记录应与当前发布一致");
  if (status.currentReleaseId !== null) {
    assert.ok(
      fs.existsSync(path.join(dataDir, "releases", String(status.currentReleaseId))),
      "生效记录指向的包必须完整可读",
    );
  }
}

const PUBLISH_CRASH_POINTS = [
  "publish.afterPackageStore",
  "publish.afterDbCommit",
  "publish.afterPointerSwitch",
];

for (const point of PUBLISH_CRASH_POINTS) {
  test(`发布在 ${point} 崩溃：恢复重试后发布效果唯一、包逐字节完整`, () => {
    const dataDir = freshDir("edgeforge-data-");
    const src = makePackage("A", 2 * 1024 * 1024);
    const snapshot = snapshotOf(src);

    const crashed = runDriver([dataDir, "publish", "pub-1", src], { EDGEFORGE_CRASH_AT: point });
    assert.notEqual(crashed.code, 0, "注入崩溃后进程应异常退出");

    const manager = new GatewayManager(dataDir);
    const recovered = manager.recover();
    assertConsistent(dataDir, recovered);

    const retry = manager.publish({ requestId: "pub-1", sourceDir: src });
    assert.equal(retry.releaseId, 1);
    assert.equal(retry.generation, 1);

    const again = manager.publish({ requestId: "pub-1", sourceDir: src });
    assert.equal(again.duplicate, true);

    const status = manager.getStatus();
    assert.equal(status.releases.length, 1, "只能产生一次发布记录");
    assert.equal(status.generation, 1, "只能推进一次运行代次");
    assert.equal(status.currentReleaseId, 1);
    assertConsistent(dataDir, status);
    assertDirsEqual(path.join(dataDir, "releases", "1"), snapshot);
    manager.close();
  });
}

test("发布在崩溃后未重试时，恢复不留下半次发布", () => {
  const dataDir = freshDir("edgeforge-data-");
  const src = makePackage("A", 1024);

  const crashed = runDriver([dataDir, "publish", "pub-1", src], {
    EDGEFORGE_CRASH_AT: "publish.afterPackageStore",
  });
  assert.notEqual(crashed.code, 0);

  const manager = new GatewayManager(dataDir);
  const status = manager.recover();
  assert.equal(status.releases.length, 0);
  assert.equal(status.generation, 0);
  assert.equal(status.running, false);
  assertConsistent(dataDir, status);
  assert.ok(!fs.existsSync(path.join(dataDir, "releases", "1")), "暂存目录应被清理");
  manager.close();
});

const ROLLBACK_CRASH_POINTS = ["rollback.afterDbCommit", "rollback.afterPointerSwitch"];

for (const point of ROLLBACK_CRASH_POINTS) {
  test(`回退在 ${point} 崩溃：恢复重试后回退效果唯一、生效包完整`, () => {
    const dataDir = freshDir("edgeforge-data-");
    const srcA = makePackage("A", 1024 * 1024);
    const srcB = makePackage("B", 1024 * 1024);
    const snapA = snapshotOf(srcA);

    runDriver([dataDir, "publish", "pub-a", srcA]);
    runDriver([dataDir, "publish", "pub-b", srcB]);
    runDriver([dataDir, "report", "f1", "2", "1000", "fail"]);
    runDriver([dataDir, "report", "f2", "2", "2000", "fail"]);

    const crashed = runDriver([dataDir, "report", "f3", "2", "3000", "fail"], {
      EDGEFORGE_CRASH_AT: point,
    });
    assert.notEqual(crashed.code, 0, "注入崩溃后进程应异常退出");

    const manager = new GatewayManager(dataDir);
    const recovered = manager.recover();
    assert.equal(recovered.currentReleaseId, 1, "恢复后应回退到 A");
    assert.equal(recovered.generation, 3);
    assert.deepEqual(
      recovered.releases.map((r) => r.eliminated),
      [false, true],
    );
    assertConsistent(dataDir, recovered);
    assertDirsEqual(path.join(dataDir, "releases", "1"), snapA);

    const retryOut = runDriver([dataDir, "report", "f3", "2", "3000", "fail"]);
    assert.equal(retryOut.code, 0);
    const retry = JSON.parse(retryOut.stdout) as ReportResult;
    assert.equal(retry.duplicate, true);
    assert.equal(retry.rollback?.eliminatedReleaseId, 2);
    assert.equal(retry.rollback?.targetReleaseId, 1);

    const manager2 = new GatewayManager(dataDir);
    const status = manager2.recover();
    assert.equal(status.generation, 3, "重试不得再次回退");
    assert.equal(status.currentReleaseId, 1);
    assert.equal(status.releases.length, 2);
    assertConsistent(dataDir, status);
    manager2.close();
    manager.close();
  });
}

test("回退到无候选时停止运行，崩溃恢复后保持停止", () => {
  const dataDir = freshDir("edgeforge-data-");
  const src = makePackage("A", 1024);

  runDriver([dataDir, "publish", "pub-a", src]);
  runDriver([dataDir, "report", "f1", "1", "1000", "fail"]);
  runDriver([dataDir, "report", "f2", "1", "2000", "fail"]);
  const crashed = runDriver([dataDir, "report", "f3", "1", "3000", "fail"], {
    EDGEFORGE_CRASH_AT: "rollback.afterDbCommit",
  });
  assert.notEqual(crashed.code, 0);

  const manager = new GatewayManager(dataDir);
  const status = manager.recover();
  assert.equal(status.running, false);
  assert.equal(status.currentReleaseId, null);
  assert.equal(status.generation, 2);
  assertConsistent(dataDir, status);
  manager.close();
});

test("发布崩溃恢复后重试返回的结果与无中断时一致", () => {
  const dataDirSmooth = freshDir("edgeforge-data-");
  const srcSmooth = makePackage("A", 1024);
  const smoothOut = runDriver([dataDirSmooth, "publish", "pub-1", srcSmooth]);
  const smooth = JSON.parse(smoothOut.stdout) as PublishResult;

  const dataDirCrash = freshDir("edgeforge-data-");
  const srcCrash = makePackage("A", 1024);
  runDriver([dataDirCrash, "publish", "pub-1", srcCrash], {
    EDGEFORGE_CRASH_AT: "publish.afterDbCommit",
  });
  const retryOut = runDriver([dataDirCrash, "publish", "pub-1", srcCrash]);
  const retried = JSON.parse(retryOut.stdout) as PublishResult;

  assert.equal(retried.releaseId, smooth.releaseId);
  assert.equal(retried.generation, smooth.generation);
});
