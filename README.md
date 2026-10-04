# wp-uptime-store

WordPress 站群在线时长核算库。TypeScript 编写，使用 Node.js 内置 SQLite
（`node:sqlite`）持久化，由上层直接调用；实际探测由调用方负责，本库只接收
已完成的探测结论。

## 环境要求

- Node.js >= 22.13（`node:sqlite` 免标志可用；开发用的是 v24）
- 无原生依赖：`npm install` 只安装 TypeScript（开发依赖）

```bash
npm install
npm test             # 构建并运行自动化测试
npm run scale-check  # 规模验证：500 站点 / 95 天 / 约 1360 万条探测
```

## API

```ts
import { UptimeStore } from './dist/src/index.js';

const store = new UptimeStore('uptime.db');

// 接收一条已完成的探测结果（UTC 毫秒时间戳）
store.recordProbe({ siteId: 'site-1', finishedAt: 1_800_000_000_000, online: true });

// 批量接收（单事务，导入期推荐）
store.recordProbes(probeIterable);

// 查询截止 endAt 之前 24h / 7d / 30d 三个窗口的全部站点统计
const stats = store.getStats(endAt);
// => [{ siteId, hours24, days7, days30 }]
//    每个窗口: { onlineMs, offlineMs, unknownMs, onlineRatio }
//    onlineRatio = online / (online + offline)；分母为 0 时为 null

// 清理：删除 now - 90 天之前的逐次探测明细，边界只前进不后退
store.cleanup(now);

store.close();
```

## 语义规则

- 每条结论从探测完成时刻生效，直到下一条结果完成或经过 10 分钟（先到为准）；
  失效后至下一条结果前、以及首条结果之前，均为未知。
- 有效区间与查询窗口均为左闭右开；时长按实际经过的毫秒累计。
- 每个窗口 在线 + 离线 + 未知 = 窗口长度（24h 固定 86400000ms）。
- 清理保留每个站点在边界前的最后一条结果作为“锚点”，其对保留区间内
  的状态影响不丢失；完整落在保留区间内的任意历史窗口查询，在清理前后、
  关闭重开前后结果一致。

## 实现要点

- `probes` 表存逐次探测明细（清理对象）；`segments` 表存由结论推导出的
  有效状态区间，相邻同状态区间在写入时合并，因此查询只扫描少量区间行。
- 查询按站点对 30 天区间做一次条件聚合（`MIN/MAX` 裁剪 + `CASE` 过滤），
  三个窗口一次扫描得出。
- 清理边界持久化在 `meta` 表，只向前推进；`auto_vacuum=INCREMENTAL` +
  清理后 `incremental_vacuum`，文件体积不随已清理历史增长。
- 假设调用串行、同一站点结果时间严格递增、不补交已过期结果。
