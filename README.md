# local-ci-scheduler

本机 CI 调度库（TypeScript，零运行时依赖）：提交服务构建流水线、查看执行状态、等待最终结果。

## 要求

- Node.js >= 22.18（利用内置 TypeScript 类型擦除与 `node:test`，无需任何构建步骤或外部服务）。
- 不使用 Docker / 数据库 / 消息队列，不监听任何端口。

## 使用

```ts
import { CiScheduler } from 'local-ci-scheduler';

const scheduler = new CiScheduler();

const handle = scheduler.submitPipeline({
  services: [
    { name: 'api', steps: [{ name: 'build', command: 'make', args: ['api'], timeoutMs: 60_000 }] },
    { name: 'web', steps: [{ name: 'build', command: 'make', args: ['web'], timeoutMs: 60_000 }] },
  ],
  dependencies: { web: ['api'] },   // web 必须等 api 成功
  changedServices: ['api'],         // 执行范围 = api + 依赖它的 web
  concurrency: 4,                   // 全局构建进程名额
  pipelineTimeoutMs: 10 * 60_000,   // 总时限（含排队），从提交起算
  killGraceMs: 5_000,               // 可选：SIGTERM 后宽限，再 SIGKILL
});

const snapshot = handle.snapshot(); // 随时查看状态
const result = await handle.result(); // 等待最终终态
```

## 语义

- **执行范围**：变更服务及其全部直接/间接后继。范围外依赖视为已有构建成果，不执行。
- **服务**：步骤按序执行，全部退出码为 0 才成功；非零退出或启动失败即失败，剩余步骤跳过，所有（传递）后继被阻断。其他分支不受影响。
- **名额**：每个步骤从启动构建进程起占用一个名额，直到进程实际退出才归还；发出终止信号不等于已退出。服务最后一步成功后，后继立即可就绪。
- **超时**：步骤超时会被终止并按失败阻断后继；总时限到达时不再启动新步骤、终止所有运行中步骤。任一超时发生则最终结果为 `timeout`，否则存在失败为 `failed`，否则 `succeeded`。
- **完成条件**：每个选中服务都有终态，且属于本流水线的所有构建进程都已实际退出。已确定的步骤/服务/流水线终态不会被晚到的退出通知改写，名额不会重复归还。

## 开发

```sh
npm install   # 仅安装 devDependencies（typescript、@types/node，用于类型检查）
npm test      # node --test，直接运行 TypeScript 测试
npm run typecheck
```
