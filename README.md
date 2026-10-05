# workload-settlement

科研成果工作量的周期结算库。作者封顶后，积分量化同时满足成果、作者、指标三个层面的汇总约束，不会因逐项舍入让作者超限或凭空增加积分。1 个积分单位 = 0.01 工作量分。

## 用法

```ts
import { settle } from "./src/settle";

const result = settle({
  items: [
    { id: "r1", metric: "论文", budget: 100, authors: ["张三", "李四"] },
  ],
  caps: { 张三: { 论文: 60 } }, // caps[作者][指标] = 周期上限 C，缺省无上限
});
// result.items[i] = { id, allocations: { 作者: 整数积分 } }
```

## 规则

1. n 名作者的第 i 位权重为 `n - i + 1`，未封顶份额 `u = P * w / Σw`。
2. 每个作者×指标组合：若未封顶份额之和 `S > C`，该组合所有份额同乘 `C / S`；扣下的积分不转让。此步后的精确有理数份额记为 `x`。
3. 整数化 `z`（整体求解，非逐项舍入）：
   - 每格 `z ∈ {⌊x⌋, ⌈x⌉}`，未署名作者不得分；
   - 每项成果的行和 `∈ {⌊Σx⌋, ⌈Σx⌉}`；
   - 每个作者×指标组合的列和 `∈ {⌊Σx⌋, ⌈Σx⌉}` 且 `≤ C`；
   - 每个指标的总和 `= round(Σx)`（半单位向上），指标间不借分。

## 实现

- `src/fraction.ts`：BigInt 精确有理数运算。
- `src/flow.ts`：带上下界的可行循环流（Dinic）。
- `src/settle.ts`：把三层约束建成流网络（源→成果→作者×指标→指标→汇），求整数可行流。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js，全部工具链在 `package.json` 中声明。
