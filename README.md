# payroll-close

月度工资追补关账库（TypeScript）。薪酬时间线与关账记录持久化于 SQLite（Node 内置 `node:sqlite`，零运行时依赖），由上层直接调用。

## 能力

- `initEmployees`：初始化员工名单、入职月份、初始月薪（重复初始化幂等）。
- `setSalary`：改薪，按月生效；覆盖生效月起至下一条生效记录前，无下一条则持续生效；同月重复设置替换原值，修改顺序不限。
- `closeBatch`：批量关账。携带请求标识、员工集合、一个月份；每名员工从入职月起连续重估，减去此前已归属金额，差额作为本次明细（允许负数）；整批原子入账。
- `getCloseResult`：按请求标识读取已入账的关账结果。

## 语义保证

- 已入账记录永不改写；同一请求标识重试返回首次结果，后续改薪不影响回放。
- 不同请求在（员工，月份）上有交集时整批冲突，未重叠员工也不留记录、不消耗追补。
- 估算由调用方注入：`(employeeId, month, monthlySalary) => Promise<number>`，所有追补以该应付额为准。

## 使用

```ts
import { PayrollClose } from 'payroll-close';

const payroll = await PayrollClose.open('payroll.sqlite', async (employeeId, month, salary) => salary);
await payroll.initEmployees([{ employeeId: 'e1', hireMonth: '2025-01', initialSalary: 10000 }]);
await payroll.setSalary('e1', '2025-03', 13000);
const result = await payroll.closeBatch('req-1', ['e1'], '2025-03');
const replay = await payroll.getCloseResult('req-1');
```

## 构建与测试

要求 Node.js >= 22.5（内置 `node:sqlite`）。

```sh
npm install
npm test
```
