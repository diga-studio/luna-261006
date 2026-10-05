# render-queue

持久化渲染任务队列库（TypeScript）。任务状态存 SQLite，成果文件存本地目录，不实现实际渲染。

## 能力

- `enqueueBatch`：一批相机任务一次性入队；相同标识 + 相同内容的重试对应原批次，不重复创建；相同标识 + 不同内容抛错。
- `claim`：每次领取一个任务，顺序为 优先级（1 最高）→ 批次首次入队顺序 → 批内相机顺序；每次领取产生可区分的执行尝试，租期固定 60 秒，到期时刻及以后可重领。
- `submitResult`：提交执行尝试与本地成果文件。仅当仍是当前尝试且租期未到期时首次接纳；过期/被取代/字节冲突一律拒绝且不改写已存成果。成功尝试重复提交相同字节返回原成功。
- `getBatch`：查看各相机任务状态与已完成任务的可读成果（路径 + 字节）；全部相机任务成功批次才算完成。

租期为绝对时间戳，重启不延长租期、不把未过期任务立即重新分配。

## 使用

```ts
import { RenderQueue } from "render-queue";

const queue = new RenderQueue({
  dataDir: "/var/myapp/render-queue", // queue.db 与 artifacts/ 存放于此
  now: () => Date.now(),              // 业务时钟由上层提供，保证不倒退
});

queue.enqueueBatch({
  batchId: "scene-42-cameras",
  priority: 1, // 1 最高 .. 5 最低
  cameras: [{ cameraId: "front" }, { cameraId: "back" }],
});

const claimed = queue.claim();
if (claimed) {
  // ... 渲染，把成果写到本地文件 ...
  const result = queue.submitResult(claimed.attemptId, "/path/to/result.png");
  if (result.ok) {
    // 成果已入库，源文件可删除
  }
}

const view = queue.getBatch("scene-42-cameras");
queue.close();
```

所有成果按不透明字节处理并复制到 `dataDir/artifacts/`，调用方删除源文件后仍可逐字节读回。

## 要求与构建

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生/外部服务依赖）
- `npm install` 后 `npm test` 即可运行（先 `tsc` 编译，再用 `node --test` 跑测试）
