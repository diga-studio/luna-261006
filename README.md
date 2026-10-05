# TrafficForge 请求分配库

进程内的单后端池请求分配库（TypeScript）。配置与运行状态全部保存在进程内，
后端调用由上层注入的异步执行器完成。

## 特性

- 提交可取消请求、整体替换目标配置、查询当前占用（含已移除但仍有占用的目标）
- 只分配给仍有空位的目标；选占用最少者，并列按标识字典序
- 每次尝试 3 秒等待期限，最多 3 次尝试，重试前等待 200ms / 400ms
- 超时立即取消该尝试并进入重试等待；占用直到执行器真正结束才释放
- 同一请求不会重复选择已尝试过的目标标识（即使目标被移除再加入）
- 客户端取消立即结束等待、取消所有未结束尝试并阻止未开始的重试；
  成功 / 失败 / 取消只产生一个最终结果

## 使用

```ts
import { Allocator } from "traffic-forge";

const allocator = new Allocator({
  executor: async (targetId, signal) => {
    // 调用后端，可监听 signal.onCancel(...) 提前中止
    return { ok: true };
  },
});

allocator.setTargets([{ id: "backend-1", maxConcurrency: 4 }]);

const handle = allocator.submit();
// handle.cancel(); // 可随时取消
const outcome = await handle.outcome; // success | failed | no-target | cancelled

allocator.occupancy(); // [{ id, occupied, maxConcurrency }]
```

可选参数：`attemptTimeoutMs`（默认 3000）、`retryDelaysMs`（默认 `[200, 400]`）、
`maxAttempts`（默认 3）。

## 开发

要求 Node.js >= 22.18（测试使用内置 test runner 与原生 TypeScript 类型剥离）。

```sh
npm install
npm test     # 编译 src -> dist 并运行 test/*.test.ts
npm run build
```
