# task26100687 — TrafficForge 请求分配库

单后端池的进程内请求分配库（TypeScript）。配置与运行状态均保存在进程内，由上层调用。

## 构建与测试

```sh
npm install
npm test        # 编译 src/ 与 test/ 后运行 node:test
npm run build   # 仅编译到 dist/
```

仅需 Node.js（>= 18）与 npm，无其他服务依赖。

## API 概览

```ts
import { Allocator } from "./dist/src/index.js";

const allocator = new Allocator(async (targetId, signal) => {
  // 上层提供的进程内异步执行器：返回 "success" | "failure"
  // signal.cancelled 为 true 时应尽快放弃（允许忽略）
  return "success";
});

allocator.replaceConfig([{ id: "backend-1", maxConcurrency: 4 }]);

const handle = allocator.submit();
handle.cancel();                 // 可选：立即结束等待并取消所有未结束尝试
const result = await handle.result;
// { status: "success" | "failure" | "cancelled" | "no-available-target" }

allocator.occupancy();           // 当前占用快照（含已移除但仍有占用的目标）
```

## 行为要点

- 只分配给当前配置中有空位的目标；选占用最少者，并列按标识字典序。
- 一次尝试从执行器开始到真正结束始终占一个名额；取消、超时、目标被移除都不提前释放。
- 每次尝试限时 3 秒；失败/超时后最多重试 2 次（共 3 次），重试前分别等待 200ms、400ms。
- 超时立即向该尝试发取消信号并进入重试等待；迟到结果只释放占用。
- 同一请求不会重复选择已尝试过的目标标识（即使目标被移除再加入）。
- 每次分配按当时的完整配置重新选择；无符合条件目标时立即以 `no-available-target` 结束，不排队。
- 客户端取消立即结束等待，向所有未结束尝试发取消信号，并阻止未开始的重试；最终结果唯一。
- 配置整体替换生效；移除目标不取消已有尝试，同标识重新加入时旧占用继续计入上限；降低上限不终止已有尝试，占用降到新上限以下前不新增尝试。

时间参数可通过构造函数第二参数覆盖（用于测试）：
`new Allocator(executor, { attemptTimeoutMs, retryDelaysMs, maxAttempts })`。
