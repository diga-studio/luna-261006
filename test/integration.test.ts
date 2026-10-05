import { test } from "node:test";
import assert from "node:assert/strict";
import { CiScheduler } from "../src/index";
import { PipelineSpec, StepSpec } from "../src/types";

const node = process.execPath;

function step(name: string, script: string): StepSpec {
  return { name, command: node, args: ["-e", script] };
}

test("真实进程：成功、失败与步骤超时", async () => {
  const scheduler = new CiScheduler();

  // 成功路径：两步顺序执行
  const ok = scheduler.submit({
    services: [
      {
        name: "svc-ok",
        dependencies: [],
        steps: [step("s1", "process.exit(0)"), step("s2", "process.exit(0)")],
      },
    ],
    changed: ["svc-ok"],
    maxParallel: 2,
    stepTimeoutMs: 10_000,
    pipelineTimeoutMs: 30_000,
  });
  const okFinal = await ok.wait();
  assert.equal(okFinal.result, "success");
  assert.equal(okFinal.services["svc-ok"]!.steps.length, 2);

  // 失败路径：非零退出，后续步骤不执行，后继被阻断
  const failSpec: PipelineSpec = {
    services: [
      {
        name: "svc-fail",
        dependencies: [],
        steps: [step("f1", "process.exit(3)"), step("f2", "process.exit(0)")],
      },
      {
        name: "svc-down",
        dependencies: ["svc-fail"],
        steps: [step("d1", "process.exit(0)")],
      },
    ],
    changed: ["svc-fail"],
    maxParallel: 2,
    stepTimeoutMs: 10_000,
    pipelineTimeoutMs: 30_000,
  };
  const failFinal = await scheduler.submit(failSpec).wait();
  assert.equal(failFinal.result, "failure");
  assert.equal(failFinal.services["svc-fail"]!.steps[0]!.exitCode, 3);
  assert.equal(failFinal.services["svc-fail"]!.steps[1]!.state, "skipped");
  assert.equal(failFinal.services["svc-down"]!.state, "blocked");

  // 步骤超时：进程被终止并实际退出后才报告完成
  const slow = scheduler.submit({
    services: [
      {
        name: "svc-slow",
        dependencies: [],
        steps: [step("slow1", "setTimeout(() => {}, 60000)")],
      },
    ],
    changed: ["svc-slow"],
    maxParallel: 1,
    stepTimeoutMs: 100,
    pipelineTimeoutMs: 30_000,
  });
  const slowFinal = await slow.wait();
  assert.equal(slowFinal.result, "timeout");
  assert.equal(slowFinal.services["svc-slow"]!.steps[0]!.state, "timed_out");
});
