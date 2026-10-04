# task26100641 — ProxShield 进程内响应体带宽整形库

按档位（profile）对响应体字节流做进程内带宽整形。档位匹配由调用方完成，
每条传输只携带可信的 `profileId`；同一档位的所有传输共享该档位的速率
`R`（字节/秒，创建时指定，运行中不变），不同档位完全独立。

## 构建与测试可做

```sh
npm install
npm test   # = tsc 构建 + node --test（仅需 Node.js，无外部服务）
```

## API

```ts
import { createShaper } from './src';

const shaper = createShaper({
  rates: { hd: 8000, sd: 4000 },   // 字节/秒
  clock,                            // 注入的单调毫秒时钟
});

const handle = shaper.start('hd', source, write);
// source: AsyncIterable<Uint8Array>，每块 1..65536 字节
// write:  (chunk: Uint8Array) => Promise<unknown>
await handle.done;   // {status:'completed'|'cancelled'} | {status:'failed', reason}
handle.cancel();     // 立即终止；done 以 cancelled 结束，不等悬挂的 Promise
```

- `done` 仅在全部字节无损、原序交付且最后一次 `write` 完成后以
  `completed` 结束；`cancel()` 立即以 `cancelled` 结束；输入/输出失败以
  `failed` 结束且只终止本传输，迟到完成的 Promise 不会将其复活。
- `cancel()` 返回后，该传输的 `next`/`write` 不会再被调用。

## 时钟接口

```ts
interface Clock {
  now(): number;                                       // 单调毫秒
  setTimeout(cb: () => void, delayMs: number): () => void; // 返回取消函数
}
```

全部计时都通过注入的时钟与可取消的一次性定时器完成；测试用虚拟时钟
（`test/helpers.ts` 的 `VirtualClock`），不依赖真实等待。

## 整形语义

- **共享令牌桶**：每档位一个桶，容量 4096 字节，按 `R` 匀速补充。字节在
  调用 `write` 时计入带宽；任意区间 `(t1,t2]` 内同档位写出字节数
  ≤ `R×(t2−t1)/1000 + 4096`。空闲后最多突发 4096 字节；时钟大幅跳进
  也只把桶补到 4096，不会集中补发停顿期间的额度。
- **持续吞吐**：供数不断时，任意 ≥1000ms 区间输出 ≥ `R×秒数 − 4096`。
- **按字节公平**：每次 `write` 最多 1024 字节；调度器总是服务"已写字节数
  最少"的可发送传输，且任何传输不得领先同档位其他活跃传输超过 1024
  字节——与输入分块大小无关。新流从当前最大进度加入，不追补加入前的
  流量；挂起（`next`/`write` 长期未完成）的流在时钟走过后被排除出公平
  集，不会拖住同档位其他流。
- **背压**：同一传输最多一个未完成的 `next` 或 `write`；当前输入块写完前
  不拉取下一块，最多保留一个未发送完的输入块。
- **无空转**：没有可推进的待写任务时不留定时器；取消全部传输后所有
  `done` 结束且无残留定时器。
