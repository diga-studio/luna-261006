# proxshield-shaper

ProxShield 进程内响应体带宽整形库（TypeScript）。档位匹配由调用方完成，每条传输只携带可信的 `profileId`。

## 特性

- 创建时按档位注入速率 R（字节/秒），运行中不变；同档位所有传输共享 R，不同档位相互独立。
- 全部计时通过注入的单调毫秒时钟与可取消一次性定时器完成（`Clock` 接口，见 `src/clock.ts`）。
- 每档位一个令牌桶（容量 4096 字节）：任意区间 `(t1, t2]` 的输出不超过 `R*(t2-t1)/1000 + 4096`，初始及空闲后最多突发 4096 字节，时钟跳进不会补发。
- 按字节公平：调度器总是推进"已发送字节数最少"的可发送流，单次 `write` 不超过 1024 字节；同档位连续供数流的输出差不超过 4096 字节，与输入分块无关；新流以当前最大发送量为基线加入，不追补历史流量。
- 背压：同一传输最多一个未完成的 `next`/`write`，当前块写完前不拉取下一块。
- `cancel()` 立即终止传输，不等待悬挂的 Promise；迟到的完成不会复活传输；无可推进任务时不残留定时器。

## API

```ts
import { createShaper, systemClock } from "proxshield-shaper";

const shaper = createShaper(systemClock, { hd: 1_000_000, sd: 200_000 });
const { done, cancel } = shaper.start("hd", sourceAsyncIterable, async (chunk) => {
  await response.write(chunk);
});
await done; // 全部字节无损原序交付且最后一次 write 完成后解决
```

- `done` 在取消时以 `CancelledError` 拒绝；输入/输出失败时以该错误拒绝，且只终止本传输。

## 构建与测试

```sh
npm install
npm test
```

只依赖 `typescript` 一个开发依赖；测试使用 Node 内置 test runner、虚拟时钟与可控 Promise，不依赖真实等待。
