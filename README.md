# approval-sla-clock

审批 SLA 工作时钟库（TypeScript）。由上层流程引擎直接调用，无接口层；
日历由调用方传入，计算数据仅存内存。只负责累计工作时长与定位里程碑，
不发送提醒、不执行转交。

## 安装与测试

```sh
npm install
npm test
```

只依赖 Node.js（>=18）与开发依赖 TypeScript；测试使用 Node 内置 test runner。

## API

```ts
import { accumulateWorkMs, locateMilestones } from "approval-sla-clock";
import type { WorkCalendar, TimeInterval, Milestones } from "approval-sla-clock";
```

### 日历模型

```ts
const calendar: WorkCalendar = {
  timeZone: "America/New_York",        // IANA 时区
  weekly: [                            // 索引 0=周日 … 6=周六
    [],
    [{ startMinutes: 540, endMinutes: 1020 }], // 周一 09:00-17:00
    // ...
  ],
  exceptions: {
    "2025-11-02": [{ startMinutes: 75, endMinutes: 105 }], // 替换当天安排
    "2025-12-25": [],                                      // 空数组 = 假日
  },
};
```

- 区间左闭右开，精确到分钟；`endMinutes < startMinutes` 表示次日结束，
  二者相同表示延续 24 小时；区间可重叠（只计一次）、可跨午夜。
- 例外完全替换该本地日期的每周安排；区间归属于开始的本地日期，
  假日不会截断前一天开始的跨午夜区间。

### 累计工作时长

```ts
const ms = accumulateWorkMs(calendar, fromUtcMs, toUtcMs);
```

按真实经过的毫秒累计：夏令时跳过的本地时间不计时，重复的本地时间两次都计时；
支持非整小时偏移（如 Australia/Lord_Howe）。

### 定位里程碑

```ts
const m: Milestones = locateMilestones(calendar, startUtcMs, slaMs, maxUtcMs);
// m.remind50 / m.remind80 / m.deadline: UTC 毫秒时间戳，不可达为 null
```

- 提醒额度为 `slaMs` 乘 50% / 80% 后向上取整到毫秒；
- 各里程碑取累计工作时长首次达到对应额度的 UTC 时刻；
- 额度恰好在下班边界耗尽时取该边界；`maxUtcMs` 本身可成为里程碑；
- `slaMs` 必须为正整数毫秒。

## 性能

单次跨 20 年的累计或定位查询在 1 秒内完成（限制 5 秒），
支持每周 14 段区间与 2000 个例外日期。耗时测试见 `test/perf.test.ts`，
随 `npm test` 一起运行。
