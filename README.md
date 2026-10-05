# payroll-hours

工时工资核算库：为时薪员工按结算区间批量核算基础工资与加班补差。

## 规则

- 企业时区固定 `America/New_York`；工时与调薪记录均为 UTC 秒级瞬间，半开区间。
- 同一员工重复/交叠的记录每秒只计一次有效工时；不同员工独立核算。
- 自然周为本地周一 00:00 起；每周前 40 小时为普通工时，超出为加班（按发生先后判定）；跨周班次按秒分别归属。
- 全部有效工时按发生时费率计基础工资；加班补差 = 0.5 × 整周平均时薪 × 加班小时，
  整周平均时薪 = 整周基础工资 / 整周实际小时（含加班），周后半段调薪会影响前半周补差。
- 结算区间以本地午夜为界、含起点不含终点；只支付区间内工时，但分类与平均时薪使用完整周上下文。
- 全程使用精确有理数（bigint）运算，不舍入中间值；每名员工基础工资与加班补差合计后
  才四舍五入到分（半分向上）。`exact*` 字段返回未舍入的精确有理数，可用于跨区间对账。

## 使用

```js
const { settlePayroll } = require("payroll-hours");

const results = settlePayroll(
  [{ employeeId: "e1", startUtc: 1774868400, endUtc: 1774872000 }],   // 工时记录
  [{ employeeId: "e1", effectiveUtc: 1774800000, centsPerHour: 2000 }], // 调薪记录
  { startDate: "2026-03-01", endDate: "2026-04-01" },                  // 结算区间（本地日期）
);
// => [{ employeeId, basePayCents, overtimePremiumCents, totalCents,
//       exactBasePay, exactOvertimePremium, exactTotal }]
```

调用方需保证费率覆盖全部工时，并提供结算区间触及的完整自然周内的全部记录。

## 构建与测试

```sh
npm install
npm test        # 编译 TypeScript 并运行 node:test 测试
```
