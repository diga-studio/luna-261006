# watch-coverage-ledger

观看覆盖核算库（TypeScript）：由上层播放统计模块直接调用，数据保存在进程内存。
只核算影片时间轴上的有效覆盖，不负责推断播放器行为。

## 能力

- `upsertSegment(key, videoDurationMs, segment)`：登记或修订片段。修订整体替换该标识的旧区间；同一标识只有最高版本生效，较低版本与同版本重放不改变结果。
- `revokeSegment(key, videoDurationMs, segmentId, version)`：撤销片段。只移除该标识的贡献；撤销可以先于登记到达，之后旧版本不得复活，更高版本可重新生效。
- `getProgress(key, videoDurationMs)`：返回 `{ coveredMs, completed }`，即当前有效片段区间并集的总毫秒数与完成状态（覆盖量达到总时长 90% 即完成，整数比较不四舍五入）。

## 约定

- 统计对象由租户、用户档案、影片三者组成，彼此完全隔离；片段标识只在所属统计对象内唯一。
- 身份与影片总时长（整数毫秒）由调用方提供且可信；片段区间为 `[startMs, endMs)`，含起点、不含终点。

## 使用

```ts
import { WatchCoverageLedger } from "watch-coverage-ledger";

const ledger = new WatchCoverageLedger();
const key = { tenantId: "t1", profileId: "p1", videoId: "v1" };

ledger.upsertSegment(key, 60_000, { segmentId: "s1", version: 1, startMs: 0, endMs: 30_000 });
ledger.revokeSegment(key, 60_000, "s1", 2);
const { coveredMs, completed } = ledger.getProgress(key, 60_000);
```

## 构建与测试

```sh
npm install
npm test
```
