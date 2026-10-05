import { test } from "node:test";
import assert from "node:assert/strict";
import { CiScheduler } from "../src/index";
import { PipelineSpec } from "../src/types";
import { FakeRunner, sleep, svc } from "./helpers";

function diamondSpec(changed: string[]): PipelineSpec {
  return {
    services: [
      svc("base", [], ["base-build"]),
      svc("left", ["base"], ["left-build"]),
      svc("right", ["base"], ["right-build"]),
      svc("top", ["left", "right"], ["top-build"]),
      svc("solo", [], ["solo-build"]),
      svc("outside", [], ["outside-build"]),
    ],
    changed,
    maxParallel: 2,
    stepTimeoutMs: 10_000,
    pipelineTimeoutMs: 60_000,
  };
}

test("菱形依赖中一个前置失败：后继被阻断，独立分支完成", async () => {
  const runner = new FakeRunner();
  const scheduler = new CiScheduler(runner);
  const handle = scheduler.submit(diamondSpec(["base", "solo"]));

  // 提交后立即调度：base 与 solo 就绪（各占一个名额），范围外服务不出现
  assert.ok(runner.started("base-build"));
  assert.ok(runner.started("solo-build"));
  assert.equal(handle.status().phase, "running");
  assert.equal(handle.status().services["outside"], undefined);

  // base 成功：left 立即就绪（不必等同层的 solo 结束）
  runner.find("base-build")!.exit(0);
  await sleep(0);
  assert.ok(runner.started("left-build"), "base 成功后 left 应立即就绪");
  assert.ok(!runner.find("solo-build")!.hasExited, "此时 solo 仍在运行");

  // solo 成功，释放名额给 right
  runner.find("solo-build")!.exit(0);
  await sleep(0);
  assert.ok(runner.started("right-build"));

  // left 失败：top 必须被阻断，不得启动
  runner.find("left-build")!.exit(1);
  await sleep(0);
  assert.ok(!runner.started("top-build"), "失败服务的后继不得启动");

  // right 成功，独立分支正常完成
  runner.find("right-build")!.exit(0);

  const final = await handle.wait();
  assert.equal(final.phase, "completed");
  assert.equal(final.result, "failure");
  assert.equal(final.services["left"]!.state, "failed");
  assert.equal(final.services["left"]!.steps[0]!.exitCode, 1);
  assert.equal(final.services["top"]!.state, "blocked");
  assert.equal(final.services["top"]!.steps[0]!.state, "skipped");
  assert.equal(final.services["right"]!.state, "succeeded");
  assert.equal(final.services["solo"]!.state, "succeeded");
  assert.equal(final.services["base"]!.state, "succeeded");
  assert.ok(!runner.started("top-build"));
  assert.ok(!runner.started("outside-build"), "范围外服务不执行");
});

test("全部成功：结果为 success，范围外服务不执行", async () => {
  const runner = new FakeRunner();
  const scheduler = new CiScheduler(runner);
  const handle = scheduler.submit(diamondSpec(["base"]));

  // 范围 = base 及其下游；solo/outside 不在范围内
  assert.equal(handle.status().services["solo"], undefined);
  assert.equal(handle.status().services["outside"], undefined);

  runner.find("base-build")!.exit(0);
  await sleep(0);
  runner.find("left-build")!.exit(0);
  await sleep(0);
  runner.find("right-build")!.exit(0);
  await sleep(0);
  assert.ok(runner.started("top-build"), "全部前置成功后 top 就绪");
  runner.find("top-build")!.exit(0);

  const final = await handle.wait();
  assert.equal(final.result, "success");
  assert.equal(final.services["top"]!.state, "succeeded");
  assert.ok(!runner.started("solo-build"));
});
