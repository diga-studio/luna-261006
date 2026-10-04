# wildpine-med-scheduler

WildPine 给药剂次时间核算库（TypeScript）。由上层直接调用，药单历史与给药
记录保存在 SQLite（Node.js 内置 `node:sqlite`，无原生扩展、无外部服务）。

## 能力

- `loadOrder(order)`：装载已审核药单。药单属于一名营员，含营期（IANA 时区 +
  当地开始/结束日期，左闭右开）与若干版本（每日服药时刻集合 + 左闭右开 UTC
  有效区间，区间互不重叠）。装载后的药单历史不可修改，重复装载同一
  `orderId` 会抛错。
- `recordAdministration(doseIdentity, administeredUtc)`：针对一个确定剂次登记
  实际给药 UTC 时刻。一个剂次只能登记一次，再次登记抛错且不覆盖原记录。
- `queryDoses(fromUtc, toUtc, observedAtUtc)`：按计划 UTC 时刻筛选左闭右开
  区间，返回剂次及其在观察时刻的状态：
  - `administered`：实际给药时刻不晚于观察时刻；
  - `overdue`：观察时刻达到计划时刻 + 15 分钟（恰好 15 分钟算逾期）；
  - `pending`：其余。

## 剂次核算规则

- 每个（原定当地日期, 原定时刻）在每个版本下至多产生一个剂次：先按原定日期
  判断是否属于营期，再换算计划 UTC 时刻，最后判断该时刻是否落入版本有效
  区间。版本切换点只属于新版。
- 当地时刻重复（时钟回拨）时取较早的 UTC 时刻，即使它落在版本有效区间外，
  也不改取第二次出现。
- 当地时刻不存在（时钟前拨）时按实际偏移变化量向后平移（一小时缺口 02:30
  移至 03:30；30 分钟缺口 02:15 移至 02:45），不一律移至缺口结束点。
- 整个当地日期不存在（如 Pacific/Apia 2011-12-30）时，该日期不产生剂次。
- 剂次身份 = (orderId, versionId, 原定当地日期, 原定时刻)，不随查询范围、
  给药状态或重新打开数据库而改变；不同原定时刻即使换算到相同 UTC 时刻，
  仍是不同剂次，可分别登记。
- 查询区间任意切分后在相同观察时刻分别查询，合并结果与完整查询一致。
- 时区换算只使用 `Intl` 与显式 IANA 时区，支持 30 分钟跳变与整日跳过，
  不依赖宿主默认时区。

## 使用

```ts
import { WildPineScheduler } from "wildpine-med-scheduler";

const scheduler = new WildPineScheduler({ filename: "meds.sqlite" }); // 或 ":memory:"
scheduler.loadOrder({
  orderId: "order-1",
  camperId: "camper-1",
  session: { timeZone: "America/New_York", startDate: "2025-03-01", endDate: "2025-04-01" },
  versions: [
    {
      versionId: "v1",
      times: ["08:00", "20:00"],
      validFromUtc: "2025-03-01T00:00:00.000Z",
      validToUtc: "2025-04-01T00:00:00.000Z",
    },
  ],
});
const doses = scheduler.queryDoses(
  "2025-03-09T00:00:00.000Z",
  "2025-03-10T00:00:00.000Z",
  "2025-03-09T12:00:00.000Z",
);
const { scheduledUtc, status, administeredUtc, camperId, ...identity } = doses[0];
scheduler.recordAdministration(identity, "2025-03-09T12:05:00.000Z");
```

## 构建与测试

要求 Node.js >= 22.13（内置 `node:sqlite`）。在干净机器上：

```sh
npm install
npm test
```

`npm test` 会用 `tsc` 编译 `src/` 与 `test/` 后以 `node --test` 运行全部测试。
