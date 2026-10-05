# subsidy-ledger

员工补贴账本库（TypeScript + SQLite）。金额一律为整数分，时间由可注入时钟提供，
状态持久化在单个 SQLite 文件中，关闭后重开不丢失。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无需任何原生模块或外部服务）
- `npm install` 后 `npm test` 即可构建并运行全部测试

## API

```ts
import { Ledger } from 'subsidy-ledger';

const ledger = new Ledger('ledger.db', { clock: () => Date.now() }); // clock 可注入
ledger.credit('emp-1', 1000, 'key-1');        // 发放当前 UTC 月份额度
const r = ledger.redeem('emp-1', 600, 'key-2'); // 足额扣款，按到期顺序跨批次
ledger.cancel('emp-1', r.redemptionId, 'key-3'); // 兑换后 24h 内可取消（恰好 24h 不行）
const snap = ledger.snapshot('emp-1');        // 可用总额 + 逐月 allocated/available/spent/expired
ledger.close();
```

## 规则摘要

- 额度按发放月份成批次，可用至发放月之后第 4 个月月初（不含该时刻）；
  到期由每次操作时的惰性扫描生效，不依赖任何清理调用。
- 兑换优先消耗到期较早的批次，可跨批次；额度不足整体失败，不留部分扣款。
- 取消按原扣款份额全额冲正：未到期部分回到 available，已到期部分计入 expired；
  spent 只统计未取消的兑换。已取消的兑换再次取消（即使换 key）返回原取消结果。
- credit/redeem/cancel 共用员工级 key 命名空间；首次成功结果保留 48 小时
  （窗口不因重试延长，恰好 48h 按新请求处理），窗口内同操作同参数返回首次结果，
  同 key 不同请求报 `KEY_CONFLICT`；失败操作不留下任何去重记录。
- 不变式：每批次 `allocated = available + spent + expired`（均非负），
  员工可用总额等于各批次 available 之和。

## 脚本

- `npm run build`：编译到 `dist/`
- `npm test`：构建并运行 `node:test` 测试
