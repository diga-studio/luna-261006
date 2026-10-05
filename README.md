# payroll-close

月度工资追补关账库（TypeScript + SQLite，零运行时依赖，使用 Node 内置 `node:sqlite`）。

## 要求

- Node.js >= 23.4（内置 `node:sqlite`，无需任何原生模块或外部服务）

## 使用

```bash
npm install
npm test
```

## API

```ts
import { PayrollService } from 'payroll-close';

const service = new PayrollService({
  dbPath: 'payroll.db',
  // 调用方提供的本地异步估算能力：按员工、月份、月薪返回该月应付整数分
  estimatePay: async (employeeId, month, monthlySalary) => monthlySalary,
});

await service.initEmployees([
  { employeeId: 'e1', hireMonth: '2026-01', baseSalary: 10000 },
]);

await service.setSalary('e1', '2026-03', 13000); // 改薪，同月重复设置会替换

const result = await service.closeBatch('req-2026-03', ['e1'], '2026-03');
// result.employees[0].lines 为逐月差额明细（含追补，可为负），total 为本次应付

const replay = await service.getCloseResult('req-2026-03'); // 同请求标识回放，永不改写
service.close();
```

## 语义

- 每名员工从入职月起连续关账；对入职至关账月的每个月重新估算应付额，减去此前已归属该月的金额，差额作为本次明细。
- 同一 `requestId` 重试返回首次结果，实际入账仅一份。
- 不同请求若员工与关账月份相交，抛出 `CloseConflictError`，整批（含未重叠员工）不入账。
- 每批写入在单个事务中完成，全部成功或全部不入账。
