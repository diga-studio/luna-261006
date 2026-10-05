# ap-aging-ledger

进程内存中的应付账款历史账龄库，由上层财务系统直接调用。无接口层、无持久化、零运行时依赖。

## 能力

- **追加入账批次**：`appendBatch(batch)` 整体生效一个批次（新发票、部分核销、核销冲回的任意组合），返回连续递增的修订号（1, 2, 3, ...）。
- **查询账龄汇总**：`queryAging(reportDate, maxRevision?)` 按报表业务日与可见修订号查询，同一组条件永远得到相同结果，旧修订不受后续追加影响。

## 使用

```ts
import { AgingLedger } from "./src/ledger.ts";

const ledger = new AgingLedger();

const rev1 = ledger.appendBatch({
  invoices: [
    {
      invoiceId: "INV-1",
      currency: "USD",
      amount: "100",          // number 或字符串，最多 4 位小数
      invoiceDate: "2024-01-05",
      dueDate: "2024-01-31",
    },
  ],
});

// 核销可以晚于实际付款日期录入
const rev2 = ledger.appendBatch({
  payments: [{ invoiceId: "INV-1", amount: 40, businessDate: "2024-02-05" }],
});

ledger.queryAging("2024-02-10", rev1); // USD 1-30 桶 = 100
ledger.queryAging("2024-02-10", rev2); // USD 1-30 桶 = 60
ledger.queryAging("2024-02-10");       // 省略修订号 = 最新修订
```

返回值为 `{ [币种]: { current, days1To30, days31To60, days61To90, over90 } }`，
金额为十进制精确字符串。包含全部已可见币种（在该修订号下已有发票记录的币种），不做汇率换算。

## 业务规则要点

- 批次内记录整体生效；核销减少余额、冲回自其业务日起恢复余额，均关联发票并沿用发票币种。
- 业务日不等于录入顺序：新批次可补录更早的业务事实，且只影响使用该修订的查询。
- 报表日尚未开票的发票不参与统计；当天发生的记录计入当天。
- 分桶：到期日距报表日 ≤0 天归 Current，1–30、31–60、61–90 天归对应桶，>90 天归 90+；整张发票余额归入同一桶。
- 日期按公历日，范围 2000–2099 年；金额最多 4 位小数，内部以放大 10^4 的 `BigInt` 精确累计。

## 设计

每个币种一个索引（`src/currencyIndex.ts`）：

- 发票按到期日排序后分块（约 128 张/块）。对任意报表日，五个账龄桶恰好对应到期日轴上五段连续区间，因此整块用聚合结构作答，只有每个边界所在的块逐票扫描。
- 每块维护两棵带历史的 Fenwick 树（`src/fenwick.ts`）：原始金额按开票日聚合、以修订号为时间维；核销/冲回按业务日聚合、以全局事件序号为时间维。历史查询即每节点内的二分查找。全部可见时退化为有序前缀和数组。
- 事件业务日早于开票日时按开票日折算，使“尚未开票不参与统计”自然等价于日期过滤。
- 金额解析与格式化见 `src/money.ts`，公历日号转换见 `src/date.ts`。

性能（本仓库 `test/scale.test.ts` 实测，Apple Silicon）：5 万发票 + 15 万核销/冲回 + 25 币种 + 20 万修订的初始载入约 0.6 秒（预算 60 秒）；随后 1 万轮“追加单笔 + 查询”约 7–8 秒（预算 15 秒）；峰值内存约 415 MiB（预算 768 MiB）。

## 构建与测试

要求 Node.js ≥ 23.6（依赖内置 TypeScript 类型剥离运行测试）。

```sh
npm install   # 可选：仅安装 typecheck 所需的 typescript/@types/node
npm test      # 直接运行，无需任何安装步骤
npm run typecheck
```

测试覆盖：

- `test/acceptance.test.ts` — 验收场景：100 元 1 月 31 日到期发票，2 月 5 日核销 40 于 3 月录入、2 月 8 日冲回 10 更晚录入，各修订分别显示 100/60/70 且旧修订不变，均在 1–30 天桶。
- `test/buckets.test.ts` — 到期当天与 30/60/90 天两侧的分桶变化、零余额、未开票、当天计入、多币种、4 位小数精确性。
- `test/randomized.test.ts` — 小规模复杂流水（含补录、冲回、多币种、跨块分裂）与逐笔朴素计算全量对拍。
- `test/scale.test.ts` — 上述规模、交替追加查询与内存上限的自动化验收。
- `test/validation.test.ts` — 重复发票号、未知发票、非法金额与日期。
