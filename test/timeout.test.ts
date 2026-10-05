import { test } from "node:test";
import assert from "node:assert/strict";
import { CiScheduler } from "../src/index";
import { PipelineSpec, PipelineStatus } from "../src/types";
import { FakeRunner, sleep, svc } from "./helpers";

test("步骤超时与流水线总超时相遇", async () => {
  const runner = new FakeRunner();
  const scheduler = new CiScheduler(runner);

  const spec: PipelineSpec = {
    services: [
      svc("a", [], ["a1", "a2"]),
      svc("b", ["a"], ["b1"]),
      svc("c", [], ["c1", "c2"]),
    ],
    changed: ["a", "c"],
    maxParallel: 1,
    stepTimeoutMs: 80,
    pipelineTimeoutMs: 200,
  };
  const handle = scheduler.submit(spec);

  // t=0：名额为 1，a1 启动，c 排队
  assert.ok(runner.started("a1"));
  assert.ok(!runner.started("c1"));

  // t≈80：a1 步骤超时 —— 发出终止要求，但进程未实际退出，名额不归还
  await sleep(110);
  const a1 = runner.find("a1")!;
  assert.equal(a1.killed, true, "步骤超时后必须发出终止要求");
  assert.equal(a1.hasExited, false);
  assert.ok(!runner.started("c1"), "进程实际退出前名额不归还，c1 不得启动");
  assert.ok(!runner.started("a2"), "失败服务的剩余步骤不执行");
  assert.ok(!runner.started("b1"), "失败服务的后继被阻断");
  let st = handle.status();
  assert.equal(st.phase, "running", "进程未退出，流水线不得报告完成");
  assert.equal(st.services["a"]!.state, "failed");
  assert.equal(st.services["a"]!.steps[0]!.state, "timed_out");
  assert.equal(st.services["a"]!.steps[1]!.state, "skipped");
  assert.equal(st.services["b"]!.state, "blocked");

  // t≈110：a1 晚到退出（退出码 0）——不得改写已定终态；名额只归还一次，c1 启动
  a1.exit(0);
  await sleep(10);
  assert.ok(runner.started("c1"), "名额释放后排队步骤启动");
  st = handle.status();
  assert.equal(st.services["a"]!.steps[0]!.state, "timed_out", "晚到退出不得改写步骤终态");
  assert.equal(st.services["a"]!.state, "failed", "晚到退出不得改写服务终态");

  // t≈200：流水线总时限到达 —— c1 被终止，未启动步骤不再启动；但 c1 未退出，不得报告完成
  await sleep(120);
  const c1 = runner.find("c1")!;
  assert.equal(c1.killed, true, "总时限到达时运行中的步骤必须被终止");
  assert.equal(c1.hasExited, false);
  assert.ok(!runner.started("c2"), "总时限后未启动步骤不得再启动");
  assert.ok(!runner.started("a2"));
  assert.ok(!runner.started("b1"));
  st = handle.status();
  assert.equal(st.phase, "running", "已启动进程实际退出前不得报告完成");

  // 验证 wait() 尚未 resolve
  let waitResolved: PipelineStatus | null = null;
  void handle.wait().then((s) => (waitResolved = s));
  await sleep(20);
  assert.equal(waitResolved, null, "wait() 在所有进程退出前不得 resolve");

  // t≈250：c1 实际退出 —— 流水线报告完成，结果为超时
  c1.exit(null);
  const final = await handle.wait();
  assert.equal(final.phase, "completed");
  assert.equal(final.result, "timeout");
  assert.equal(final.services["c"]!.state, "failed");
  assert.equal(final.services["c"]!.steps[0]!.state, "timed_out");
  assert.equal(final.services["c"]!.steps[1]!.state, "skipped");
  assert.equal(final.services["a"]!.state, "failed");
  assert.equal(final.services["b"]!.state, "blocked");

  // 报告完成后没有残留构建进程
  assert.equal(runner.active, 0, "完成后不得有残留构建进程");
  assert.ok(runner.procs.every((p) => p.hasExited));

  // 名额从未被重复归还（并发峰值不超过 maxParallel=1）
  assert.equal(runner.maxActive, 1, "名额不得重复归还导致超发");

  // 晚到的重复退出通知不改变终态
  a1.exit(0);
  c1.exit(0);
  await sleep(10);
  const again = handle.status();
  assert.equal(again.result, "timeout");
  assert.equal(again.services["a"]!.steps[0]!.state, "timed_out");
  assert.equal(again.services["c"]!.steps[0]!.state, "timed_out");
  assert.equal(runner.active, 0);
});
