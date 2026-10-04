# wp-uptime-store

WordPress 站群在线时长核算库（TypeScript + SQLite）。由上层直接调用：探测本身由调用方完成，本库接收已完成的探测结论，在本地 SQLite 中保存探测历史与统计状态，并提供在线 / 离线 / 未知时长核算。

## 环境要求

- Node.js >= 23.4（使用内置 `node:sqlite`，无任何原生依赖）
- 干净机器上 `npm install && npm test` 即可运行（devDependencies 只有 `typescript` 和 `@types/node`）

## 使用

```ts
import { UptimeStore } from "wp-uptime-store";

const store = new UptimeStore("uptime.db"); // ":memory:" 可用于纯内存

// 1. 接收探测结果（UTC 毫秒时间戳；同一站点必须严格递增到达）
store.record("site-001", 1_760_000_000_000, "online");
store.recordBatch([
  { siteId: "site-002", completedAt: 1_760_000_000_000, status: "offline" },
  // ...
]);

// 2. 查询统计：截止 now 之前的 24h / 7d / 30d 三个窗口
const stats = store.query(1_760_000_300_000);
// => [{ siteId, last24h, last7d, last30d }, ...]
//    每个窗口: { onlineMs, offlineMs, unknownMs, uptimeRatio }
//    uptimeRatio = online / (online + offline)；分母为 0 时为 null

// 3. 清理历史：删除 now - 90 天之前的逐次探测明细（边界只前进）
store.cleanup(1_760_000_300_000);

store.close();
```

## 业务规则实现

- 每条结论从探测完成时刻生效，直到下一条结果完成或经过 10 分钟（先到者为准）；失效后至下一条结果前、以及首条结果之前，均为未知。
- 有效区间与查询窗口均为左闭右开；时长按实际经过的毫秒累计，与探测次数无关。
- 每个窗口的三类时长之和恒等于窗口长度（24h / 7d / 30d，天固定 24 小时）。
- 清理边界 = 调用方给定当前时刻 - 90 天，只向前推进（持久化在 `meta` 表）。过期明细实际删除，但每站保留边界前最后一条记录，使其仍然生效的结论对保留区间的影响不丢失；完整落在保留区间内的任意历史窗口查询，在清理前后、关闭重开后结果一致。

## 存储设计

- `probe`：逐次探测明细（保留区间内的原始依据）。
- `hourly` / `daily`：结论区间在被下一条结果“封闭”时增量折叠进小时 / 天聚合桶。
- 窗口查询 = 整天天聚合 + 边缘整小时聚合 + 边缘不足一小时的原始明细扫描 + 最新记录尚未封闭的生效区间，因此任意毫秒对齐的窗口都精确且无需扫描大量历史。
- 清理后执行 `PRAGMA incremental_vacuum`，文件占用随保留区间数据规模稳定，不随已清理历史增长。

## 验证

```sh
npm test        # 单元与集成测试（含验收用例、清理一致性、重开一致性）
npm run bench   # 规模验证：500 站点 x 90 天 x 约 5 分钟一条（约 1300 万条）
```

规模验证内容（导入与查询分进程执行，计时与内存只针对查询阶段）：

- 连续 20+ 个不同历史截止时刻、每次返回全部 500 站点三个窗口，合计 < 5 秒；
- 查询阶段进程峰值 RSS < 256 MiB；
- 抽样站点与参考模型逐毫秒对账；
- 持续录入 + 清理后数据库文件占用保持稳定。

本机实测：导入约 1300 万条约 58s；21 次全量查询合计约 1.0s；查询峰值 RSS 约 112 MiB；反复录入 + 清理后文件稳定在约 580 MiB。

`bench/scale.db` 生成后再次运行 `npm run bench` 会跳过导入；`npm run bench -- --fresh` 强制重新导入。
