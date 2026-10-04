# SplitCart 还款归账库

TypeScript + SQLite（Node 内置 `node:sqlite`，无原生依赖）。每个库文件管理一个还款计划。

## 使用

```bash
npm install
npm test
```

```ts
import { openPlan } from "splitcart";

const plan = openPlan("plan.db", {
  startAt: 1_000_000,                 // UTC 整数秒
  installments: [
    { principal: 100_00, dueAt: 1_100_000 },  // 整数美分，按 dueAt 递增
    { principal: 100_00, dueAt: 1_200_000 },
  ],
});

plan.confirm("req-1", 1_050_000, 50_00); // 幂等：同 ID 同内容不重复入账
plan.advanceTo(1_300_000);               // 单调推进观察时刻
const snap = plan.inspect();             // 只读快照：各期余额、未分配余额、逐笔去向
plan.close();
```

## 归账规则

- 费用检查点为 `dueAt + 259200` 秒；检查时本金未清偿则计提 500 美分，
  每期最多一次，每计划累计最多 1500 美分（已支付的费用仍占名额）。
- 同一时刻先处理到账（多笔按 requestId 字典序），再判断费用。
- 一笔到账先抵未偿费用、再抵本金，两类内部均按期次从早到晚；剩余进入未分配余额。
- 晚到确认按 `paidAt` 参与重算：可能撤销此前计提的费用、转移封顶名额、
  改写其他确认的抵扣去向。

## 确定性保证

状态不由增量扫描累积，而是每次由「种子 + 全部确认 + 观察时刻」整体重算
（见 `src/engine.ts`）。因此同一计划、同一组确认、同一观察时刻下，
各期本金、费用、逐笔资金去向及未分配余额与确认接收顺序、逾期扫描次数无关。

## 文件结构

- `src/types.ts` — 公共类型
- `src/store.ts` — SQLite 持久化（meta / installments / confirmations 三表）
- `src/engine.ts` — 确定性重算核心
- `src/plan.ts` — `openPlan` API 与输入校验
- `test/splitcart.test.ts` — 含手算断言的场景测试
