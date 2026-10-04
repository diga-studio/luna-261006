# approval-sla-clock

审批 SLA 工作时钟库（TypeScript）。由上层流程引擎直接以库形式调用，无接口层；
日历由调用方传入，计算数据仅存内存。只负责累计工作时长与定位里程碑，
不发送提醒、不执行转交。

## 安装与测试

```bash
npm install
npm test   # 编译 + 运行全部测试（含 20 年跨度耗时测试）
```

## API

```ts
import { computeWorkMs, locateMilestones } from "approval-sla-clock";
```

### 日历模型

```ts
const calendar = {
  timeZone: "America/New_York",        // IANA 时区
  weekly: [                            // 索引 0=周日 … 6=周六（本地日期）
    [],                                // 周日休息
    [{ startMinute: 540, endMinute: 1020 }], // 周一 09:00-17:00
    // …
  ],
  exceptions: [
    { date: "2025-12-25", intervals: [] },                 // 假日：完全替换当天安排
    { date: "2025-12-24", intervals: [{ startMinute: 540, endMinute: 720 }] },
  ],
};
```

- 时间精确到分钟，区间左闭右开，可重叠、可跨午夜。
- `endMinute < startMinute` 表示次日结束；二者相等表示延续 24 小时。
- 例外完全替换该本地日期的每周安排；区间归属于开始的本地日期，
  假日不会截断前一天开始的跨午夜区间。

### computeWorkMs(calendar, fromMs, toMs): number

计算两个 UTC 时刻（epoch 毫秒，左闭右开）之间累计的工作毫秒数。
夏令时跳过的本地时间不计；重复的本地时间两次都计；重叠区间只计一次。

### locateMilestones(calendar, startMs, slaMs, latestMs): SlaMilestones

从 `startMs` 起，定位累计工作时长首次达到总额度 50% / 80% / 100% 的 UTC 时刻：

```ts
const m = locateMilestones(calendar, startMs, 8 * 3600_000, latestMs);
m.remind50.at; // epoch ms 或 null（到 latestMs 仍不可达）
m.remind80.at;
m.deadline.at;
```

- 额度按 50% / 80% 向上取整到毫秒（整数运算，无浮点误差）。
- 额度恰好在下班边界耗尽时取该边界，不顺延；`latestMs` 本身可成为里程碑。
- 各里程碑互不影响：后面的不可达不影响前面已达成的。

## 实现要点

- 时区换算只使用 `Intl.DateTimeFormat` 加显式 IANA 时区，
  不读取机器默认时区，也不依赖执行时的当前时间。
- 先把各本地日期的有效区间映射到“本地位置”轴并合并（重叠只计一次），
  再按夏令时切换点把查询区间切成常量偏移段，逐段映射回 UTC。
- 结果精确到毫秒；支持非整小时偏移（如 Australia/Lord_Howe 的 30 分钟回拨）。
- 20 年跨度、每周 14 段、2000 个例外日期的单次查询远低于 5 秒
  （见 `test/perf.test.ts`，可重复运行）。
