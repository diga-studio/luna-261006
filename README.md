# monthly-commission-ledger

多层佣金月结库（TypeScript + SQLite）。组织关系、月 PV、结算进度与最终结果全部持久化在 SQLite 中，进程随时退出后重开即可无损续算。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无任何原生/外部依赖）
- `npm install` 只需拉取两个 devDependency：`typescript`、`@types/node`

## 使用

```bash
npm install
npm test        # 编译并运行全部测试（含 10 万成员规模测试）
npm run build   # 仅编译到 dist/
```

```ts
import { CommissionLedger } from 'monthly-commission-ledger';

const ledger = new CommissionLedger('./data.db');

// 1. 录入：新增成员 / 修改推荐人 / 覆盖指定月份 PV（0–99999 整数，缺失视为 0）
ledger.addMember('alice');                 // 无推荐人
ledger.addMember('bob', 'alice');          // 推荐人是 alice
ledger.setMonthlyPv('bob', '2026-09', 100); // 100 PV = 100 美元

// 2. 发起月结：冻结当时的成员、推荐关系与该月 PV；同月重复发起返回原批次
const batch = ledger.startSettlement('2026-09');

// 3. 分批推进：每次最多结算 200 人，可在任意时刻中断、继续录入或退出程序
let info = batch;
while (info.status !== 'completed') {
  info = ledger.advance(batch.batchId); // 返回 { status, total, done }
}

// 4. 查询：处理中只能看状态与完成人数；完成后逐人查询佣金（美分）与复核标记
const result = ledger.getResult(batch.batchId, 'alice');
// { memberId: 'alice', commissionCents: 500, needsReview: false }

ledger.close();
```

## 规则

- 费率：第 1 层 5%，第 2 层 3%，第 3–5 层 2%，第 6–12 层 1%；自身 PV 不计佣。
- 佣金以美分精确计账；超过 2500 美元（> 250000 美分）标记 `needsReview`，恰好 2500 不标记，标记不截断佣金。
- 每个成员（含零佣金）都生成永久不变的月结记录。
- 发起月结即快照输入；此后的录入修改不影响该批次；完成后的结果不可变。
- 同一月份仅一个批次，重复发起幂等返回原批次；推进进度持久化，重试不倒退、不重复计佣。

## 结构

- `src/db.ts` — SQLite 打开与 schema（成员、月 PV、批次、快照、结果五张表）
- `src/calc.ts` — 费率表与单成员佣金计算（限深 12 层的迭代遍历）
- `src/ledger.ts` — `CommissionLedger` 主类：录入、发起、推进、查询，全部多步写入包在事务中
- `test/` — node:test 自动化测试：12 层费率、复核边界、快照隔离、重启续算、幂等重试、10 万成员规模
