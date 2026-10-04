# dealer-lead-sla

车商线索的营业时间 SLA 计算库（TypeScript）。线索超过 4 个营业小时仍未被首次有效跟进即算超时。库只做时间计算，不涉及线索存储、分配或通知。

## 概念

- 所有绝对时刻与时长均为整数毫秒（Unix epoch ms）。
- 营业日历 = IANA 时区 + 每周各日营业窗口 + 以当地日期（`YYYY-MM-DD`）为键的例外覆盖表；例外整日替换周表，空列表表示休息。
- 窗口用当地 `HH:mm` 表示，开始包含、结束不包含，结束允许 `24:00`；窗口可重叠，按并集计时；跨午夜窗口由调用方拆成两段。
- 夏令时语义：回拨造成的重复钟面时间两次都计入；被跳过的钟面时间没有耗时。

## API

```ts
import { elapsed, advance, inspectLead, BusinessCalendar } from "dealer-lead-sla";

elapsed(calendar, from, to): number
// 从 from 开始、到 to 之前累计的营业毫秒数。

advance(calendar, from, budgetMs): number
// 不早于 from、且累计营业耗时首次达到 budgetMs 的时刻。
// 预算为零返回 from；预算恰好在闭店时耗尽时返回该闭店时刻。

inspectLead(calendar, createdAt, firstActionAt, asOf): { elapsedBusinessMs, breached }
// firstActionAt 可为 null；计时止于 asOf 与首次跟进时刻的较早者。
// 营业耗时严格大于 4 小时（SLA_LIMIT_MS）才算超时。
```

## 日历示例

```ts
const calendar: BusinessCalendar = {
  timeZone: "America/New_York",
  weekly: [
    [],                                   // 周日
    [{ start: "09:00", end: "17:00" }],   // 周一
    [{ start: "09:00", end: "17:00" }],
    [{ start: "09:00", end: "17:00" }],
    [{ start: "09:00", end: "17:00" }],
    [{ start: "09:00", end: "17:00" }],
    [],                                   // 周六
  ],
  exceptions: {
    "2025-01-06": [],                                  // 当日休息
    "2025-01-07": [{ start: "10:00", end: "24:00" }],  // 当日特殊时段
  },
};
```

## 构建与测试

```sh
npm install
npm test
```

测试为 `test/sla.test.js`（Node 内置 test runner），直接调用 `tsc` 编译产物，覆盖纽约回拨日的重复钟面计时与 4 小时 SLA 边界。
