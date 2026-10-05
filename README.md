# subsidy-ledger

员工补贴账本库：TypeScript + SQLite（`node:sqlite`，零原生依赖）。金额一律为整数分，时间由可注入时钟提供，支持正常关闭后重开。

## 要求

- Node.js >= 22.6（直接运行 TypeScript，无需编译步骤）
- `npm install` 后 `npm test` 即可运行测试（`npm run build` 为类型检查）

## API

```ts
import { Ledger, ManualClock } from './src/index.ts';

const ledger = new Ledger('ledger.db', { clock }); // clock: { nowMs(): number }

ledger.credit(employeeId, cents, key);   // 发放当前 UTC 月份额度；同员工同月仅一笔，重复返回原记录
ledger.redeem(employeeId, cents, key);   // 足额扣款，按到期先后消耗批次；不足则整体失败
ledger.cancel(employeeId, redemptionId, key); // 24h 内可首次取消（满 24h 不允许）；已取消则返回原结果
ledger.snapshot(employeeId);             // 可用总额 + 逐月 allocated/available/spent/expired
ledger.close();                          // 正常关闭；状态与未过期去重结果在重开后仍有效
```

## 规则要点

- 批次有效期至发放月之后第 4 个月月初（不含该时刻）；到期由时钟推导，不依赖清理操作。
- 取消按最初扣款份额全额冲正：未到期部分重新可用，已到期部分计入 `expired`，不重置有效期。
- `spent` 仅统计未取消兑换；不变量：`allocated = available + spent + expired`，三者非负。
- 三个写操作共用员工范围内 key 命名空间：首次成功结果保留 48 小时（满 48h 按新请求处理），
  窗口内相同操作及参数返回首次结果，重试不延长窗口。
