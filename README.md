# hourly-payroll

时薪员工工时工资核算库（TypeScript），供薪资模块直接调用。
只处理时薪员工的基础工资与加班补差，企业时区固定为 `America/New_York`。

## 规则摘要

- 工时记录为 `[startUtc, endUtc)` 的 UTC 纪元秒，含起点不含终点；时长按实际经过秒数计算。
- 同一员工的重复、交叠记录自动去重：同一秒只计一次有效工时；不同员工独立核算。
- 自然周为本地周一 00:00 至下周一 00:00；每周前 40 小时为普通工时，超出部分按发生先后认定为加班；跨周班次按周界拆分归属。
- 调薪记录给出整数分/小时费率，从生效瞬间起使用；调用方保证费率覆盖全部工时，并提供结算区间触及的完整自然周内的全部工时与费率记录。
- 全部有效工时按发生时费率计基础工资；加班补差为整周平均时薪的 0.5 倍（整周平均时薪 = 整周基础工资 / 整周实际小时数，含加班）。
- 结算区间为本地日期 `[startLocalDate, endLocalDate)`；只支付区间内工时，但工时分类与平均时薪使用完整周上下文。
- 金额以 BigInt 有理数精确核算，中间过程不舍入；每名员工合计后才四舍五入到分，半分向上。

## 使用

```ts
import { settlePayroll } from "hourly-payroll";

const results = settlePayroll(workRecords, rateChanges, {
  startLocalDate: "2026-09-01",
  endLocalDate: "2026-10-01",
});
// results[i] = { employeeId, basePay, overtimePremium, totalRoundedCents }
// basePay / overtimePremium 为 { numerator, denominator } 精确分数（单位：分）
// totalRoundedCents 为合计后四舍五入到分的 bigint
```

## 构建与测试

```sh
npm install
npm test        # 先 tsc 编译，再用 node:test 运行全部测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js（>= 21）与 devDependencies 中的 `typescript`、`@types/node`。
