# milestone-escrow-ledger

创意项目的里程碑托管账本（TypeScript + SQLite），只处理信用额度，不涉及真实支付。作为库直接调用。

## 环境要求

- Node.js >= 22.18（使用内置 `node:sqlite` 与 `node:test`，零第三方依赖）
- `npm install` 后 `npm test` 即可运行全部测试

## 快速开始

```ts
import { Ledger } from "milestone-escrow-ledger";

const ledger = new Ledger({
  path: "ledger.db", // 缺省为 ":memory:"
  accounts: [
    { id: "alice", available: 1000 }, // 客户：可用余额
    { id: "bob", available: 0 },      // 创作者：收益余额初始为零
  ],
  projects: [{ id: "p1", clientId: "alice", creatorId: "bob" }],
});

ledger.reserve("p1", "m1", 400, "key-1"); // 冻结 400 到里程碑 m1
ledger.resolve("p1", "m1", 150, "key-2"); // 150 付给创作者，250 退回客户
ledger.cancel("p1", "key-3");             // 取消项目，退还未裁决冻结额
const snapshot = ledger.snapshot();       // 账户/项目/里程碑状态 + 资金流水
ledger.close();
```

## 规则摘要

- 金额为整数最小信用单位；可用余额、收益余额、冻结额均非负，总和恒等于初始信用总额。
- 里程碑由 `reserve` 创建；`resolve` 一次性终结（award 0..全部冻结额）；`cancel` 原子地退回全部未裁决冻结额，已裁决不追溯。
- `key` 全账本唯一并绑定操作与参数：同键同参数返回首次成功结果（不新增流水），同键不同参数拒绝（`KEY_CONFLICT`），失败调用不占用 key。
- 资金流水只追加，含来源/去向/金额，可从初始余额独立重放复算当前账目（测试中有重放校验示例）。

## 项目结构

- `src/types.ts` — 公开类型定义
- `src/ledger.ts` — 账本实现（SQLite 持久化、事务、幂等）
- `src/index.ts` — 库入口
- `test/ledger.test.ts` — node:test 测试
