# business-hours-sla

车商线索营业时间 SLA 计算库（TypeScript）。仅做时间计算，不包含线索存储、分配或通知。

## 营业日历

```ts
interface BusinessCalendar {
  timeZone: string;                              // IANA 时区
  weekly: { [weekday: number]: TimeWindow[] };   // 0 = 周日 .. 6 = 周六
  exceptions?: { [localDate: string]: TimeWindow[] }; // "YYYY-MM-DD" 整日覆盖，[] 表示休息
}
```

窗口用当地 `"HH:mm"` 表示，开始包含、结束不包含，结束允许 `"24:00"`；窗口可重叠，按并集计时；跨午夜窗口由调用方拆开。所有绝对时刻与时长均为整数毫秒。

## API

- `elapsed(calendar, from, to)`：`[from, to)` 内累计的营业毫秒数。
- `advance(calendar, from, budgetMs)`：不早于 `from`、累计营业耗时首次达到 `budgetMs` 的时刻；预算为零返回 `from`；预算恰好在闭店时耗尽返回该闭店时刻。
- `inspectLead(calendar, createdAt, firstActionAt, asOf)`：计时止于 `asOf` 与首次跟进时刻的较早者，返回 `{ elapsedMs, timedOut }`；营业耗时严格大于 4 小时才算超时，已在期限内跟进的线索不会因 `asOf` 推迟而变为超时。

时区换算基于 `Intl`，回拨造成的重复钟面时间两次都计入，跳过的钟面时间没有耗时。

## 构建与测试

```sh
npm install
npm test
```
