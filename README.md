# render-task-queue

持久化渲染任务队列库（TypeScript）。任务状态存 SQLite（经 sql.js，纯 WASM，无原生编译），
成果文件存本地目录。不实现实际渲染，由上层调用方驱动。

## 能力

- **批次入队** `enqueueBatch`：一个批次含一组相机任务，统一 1–5 级优先级（1 最高）。
  批次带调用方稳定标识；相同标识 + 相同内容的重试对应原批次，不重复建任务；
  相同标识 + 不同内容抛错（批次内容提交后不可修改）。
- **领取任务** `claim(now)`：每次一个任务，按 优先级 → 批次首次入队顺序 → 批内相机顺序 选择。
  每次领取产生新的执行尝试（attempt），租期固定 60 秒。到期时刻及以后可重新领取，
  重领仍沿用原始排队顺序。`now` 为上层提供的业务时钟（毫秒，保证不倒退）。
- **提交成果** `submit(attemptId, sourceFilePath, now)`：首次接纳时必须是当前尝试且租期未到期。
  成果按不透明字节复制进库目录，源文件保持不变；成功返回后调用方可删除源文件。
  成功尝试重复提交相同字节返回 `duplicate`（不报错、不改写）；提交不同字节返回
  `rejected/byte-mismatch`，成果不被改写。
- **查看批次** `getBatch(batchId, now?)`：返回各相机任务状态及已完成任务的可读成果
  （`result.read()` 逐字节读回）。全部任务成功批次才 `complete`。

重启后租期原样保留：未到期任务不会被重新分配，到期任务按原顺序可再领取。

## 使用

```ts
import { RenderQueue } from 'render-task-queue';

const queue = new RenderQueue({ dir: '/var/render-queue' });
await queue.open();

await queue.enqueueBatch({ batchId: 'scene-42', priority: 2, cameras: ['front', 'back'] });

const job = queue.claim(Date.now());
if (job) {
  // ... 渲染 job.camera，把成果写到本地文件 ...
  const result = queue.submit(job.attemptId, '/tmp/render-front.png', Date.now());
  // result.status: 'accepted' | 'duplicate' | 'rejected'
}

const view = queue.getBatch('scene-42', Date.now());
// view.complete、view.tasks[i].status、view.tasks[i].result?.read()

queue.close();
```

## 构建与测试

只需 Node.js（>= 20）：

```sh
npm install
npm test
```

`npm test` 会先编译（`tsc`）再用 Node 内置测试运行器跑 `test/` 下的全部用例。

## 存储布局

```
<dir>/queue.db      SQLite 数据库（批次、任务、尝试、租期）
<dir>/results/      成果文件（task-<id>.bin，写入后不可变）
```

每次写操作后整库原子落盘（临时文件 + rename），崩溃不会留下半截数据库。
