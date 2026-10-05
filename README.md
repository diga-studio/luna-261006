# 董事会议候选时段库

为分处不同时区的董事安排会议，找出整场会议都满足法定人数的候选开始时间。
纯进程内存实现，无接口层，由上层直接调用。

## 安装与运行

```bash
npm install
npm test        # 运行全部测试（vitest）
npm run build   # 编译 TypeScript 到 dist/
```

## 用法

```ts
import { BoardScheduler } from "./src/index.js";

const scheduler = new BoardScheduler();

// 1. 设置在任名册（整体替换）。timeZone 为 IANA 时区名。
scheduler.setDirectors([
  { id: "alice", timeZone: "America/New_York" },
  { id: "bob", timeZone: "Asia/Shanghai" },
]);

// 2. 替换某名董事的周可用窗口（按其本地日历每周重复）。
//    dayOfWeek: 0=周日..6=周六；startMinuteOfDay/endMinuteOfDay: 0..1439。
//    窗口左闭右开；结束早于开始表示跨到次日；起止不得相同。
scheduler.setWeeklyAvailability("alice", [
  { dayOfWeek: 1, startMinuteOfDay: 9 * 60, endMinuteOfDay: 17 * 60 },
]);

// 3. 查询候选时段。时间一律使用 UTC 纪元分钟（整分钟）。
const segments = scheduler.findCandidates({
  invitedIds: ["alice", "bob"], // 受邀子集，必须都在名册中
  quorumPercent: 60,            // 可选，默认 60；法定人数 = ceil(在任总数 * 比例)
  rangeStartUtcMinutes: Date.parse("2026-01-05T00:00:00Z") / 60000,
  rangeEndUtcMinutes: Date.parse("2026-01-12T00:00:00Z") / 60000,
  durationMinutes: 60,
});
// => [{ startUtcMinutes, endUtcMinutes }, ...]
//    全部合格开始分钟压缩为最大连续区间，每段首尾均为合格开始分钟（闭区间）。
```

## 语义要点

- 窗口按董事本地日历每周重复，不按固定 UTC 偏移；夏令时切换由库内处理：
  春拨时不存在的本地时间不补齐，秋拨时重复墙钟的两次出现分别判断。
- 法定人数 = ceil(在任董事总数 × quorumPercent)；未受邀或无可用时间的
  在任董事仍计入分母，只有受邀董事计入出席。
- 一名董事只有在会议 `[s, s+时长)` 的每个真实时刻都可用才计入该场人数；
  不同董事轮换维持瞬时人数不算整场达标。
- 搜索范围与会议均为左闭右开，会议必须完整落在搜索范围内，
  候选起点限 UTC 整分钟。

## 结构

- `src/types.ts` — 公开类型定义
- `src/tz.ts` — 基于 Intl 的时区偏移计算与 DST 恒定偏移切分
- `src/availability.ts` — 周窗口 → UTC 可用区间（正向 UTC→本地映射）
- `src/scheduler.ts` — `BoardScheduler`：名册、可用性管理与候选查询
- `test/` — DST 验收、法定人数、通用语义、随机对照独立核算、规定规模性能
