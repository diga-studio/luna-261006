# local-ci-scheduler

本机 CI 调度库（TypeScript）：提交流水线、查看执行状态、等待最终结果。

## 使用

```ts
import { CiScheduler } from "local-ci-scheduler";

const scheduler = new CiScheduler();
const handle = scheduler.submit({
  services: [
    { name: "base", dependencies: [], steps: [{ name: "build", command: "make", args: ["base"] }] },
    { name: "app", dependencies: ["base"], steps: [{ name: "build", command: "make", args: ["app"] }] },
  ],
  changed: ["base"],        // 执行范围 = 变更服务 + 所有直接/间接依赖它们的服务
  maxParallel: 4,           // 每个步骤占一个执行名额，名额在进程实际退出时才归还
  stepTimeoutMs: 60_000,    // 单步骤时限，从步骤启动起算
  pipelineTimeoutMs: 600_000, // 流水线总时限，从提交起算，含排队时间
});

console.log(handle.status());   // 当前快照
const final = await handle.wait(); // 最终状态：success | failure | timeout
```

- 步骤顺序执行，全部退出码为 0 服务才成功；非零退出或启动失败使服务失败并阻断其后继，独立分支继续。
- 步骤超时会被终止并按失败处理；总时限到达时停止该流水线全部未完成工作。
- 任一超时则最终结果为 `timeout`，否则存在失败为 `failure`，否则为 `success`。
- 流水线只在所有选中服务有终态且所有构建进程都退出后才报告完成；终态不会被晚到的退出通知改写。

## 开发

```sh
npm install
npm test   # 编译 src 与 test 后运行 node:test 测试
```

测试通过注入 `ProcessRunner` 假实现（`test/helpers.ts`）精确控制进程退出时机，
另有用真实子进程（`SpawnProcessRunner`）的集成冒烟测试。
