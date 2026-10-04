# milestone-ledger

创意项目的里程碑托管账本（TypeScript + SQLite）。只处理信用额度，不涉及真实支付。
金额一律为整数最小信用单位。

## 使用

```ts
import { Ledger, replay } from "milestone-ledger";

const ledger = new Ledger(
  {
    accounts: [
      { accountId: "client", available: 1000 }, // 初始化时一次性提供可用余额
      { accountId: "creator", available: 0 },
    ],
    projects: [{ projectId: "p1", clientId: "client", creatorId: "creator" }],
  },
  ":memory:", // 或传 SQLite 文件路径持久化
);

ledger.reserve("p1", "m1", 400, "key-r1");   // 冻结并创建里程碑
ledger.resolve("p1", "m1", 150, "key-s1");   // 裁决：150 给创作者，250 退客户
ledger.cancel("p1", "key-c1");               // 取消项目：退回所有未裁决冻结额
const snapshot = ledger.snapshot();          // 账户/项目/里程碑状态 + 资金流水
const report = replay(snapshot);             // 从初始余额独立重放流水复算
```

- `key` 全账本唯一并绑定操作与参数：同键同参数返回首次成功结果，同键不同参数拒绝，失败调用不占键。
- 所有余额与冻结额非负，总和恒等于初始信用总额；流水只追加，可独立重放。

## 构建与测试

```sh
npm install
npm test
```

依赖仅为开发依赖 `typescript` 与 `@types/node`；运行时使用 Node.js 内置的
`node:sqlite`（需 Node >= 22.5）与 `node:test`，无需任何外部服务。
