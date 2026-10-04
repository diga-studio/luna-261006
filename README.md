# SplitCart 还款归账库

TypeScript + SQLite 实现的还款归账库。每个库文件管理一个还款计划；
到账确认可以晚到（`paidAt` 早于当前观察时刻），归账结果与确认接收顺序、
逾期扫描次数无关。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生依赖）
- `npm install` 后 `npm test` 即可运行（唯一 devDependency 是 typescript）

## 用法

```ts
import { openPlan } from "splitcart-repayment";

const plan = openPlan("plan.db", {
  startAt: 1_000_000,
  installments: [
    { principal: 700, dueAt: 1_001_000 },
    { principal: 700, dueAt: 1_002_000 },
  ],
});

plan.confirm("req-1", 1_000_500, 300); // 幂等：同 ID 同内容不重复入账
plan.advanceTo(1_262_400);             // 单调推进观察时刻，补齐费用
const snap = plan.inspect();           // 只读快照：各期余额、未分配余额、逐笔去向
plan.close();

const reopened = openPlan("plan.db");  // 重开：忽略 seed，使用已保存数据
```

## 经济时间规则

- 每期在 `dueAt + 259200` 秒检查本金：仍有未偿本金则计提 500 美分费用，
  每期最多一次，每计划累计最多 1500 美分（已支付的费用仍占名额）。
- 同一时刻先处理到账（按 `requestId` 字典序），再判断费用。
- 一笔钱先抵未偿费用、再抵本金，两类内部均按期次从早到晚；剩余进入未分配余额。
- 晚到确认按 `paidAt` 参与重放：可能撤销此前计提的费用（封顶名额顺延给更晚的
  期次），也可能改变其他确认的抵扣去向。只有费用检查时已清偿的本金才能避免费用。

## 设计

归账采用**确定性重放**：SQLite 只持久化种子、确认流水与观察时刻；
`inspect()` 由 `(seed, confirmations, now)` 按经济时间规则重放计算快照，
因此结果天然与接收顺序、扫描次数无关，且晚到确认自动修正全部派生状态。

- `src/types.ts` — 公共类型
- `src/store.ts` — SQLite 持久化（种子、确认流水、观察时刻）
- `src/engine.ts` — 确定性重放归账引擎
- `src/plan.ts` — `openPlan` API 与输入校验
- `test/` — 场景与不变量测试（`node:test`）

金额均为整数美分，时间均为 UTC 整数秒；`paidAt` 必须位于 `[startAt, now]`。
