# narrativeflow-ab-exact

NarrativeFlow 多版本文案 A/B 整体显著性计算库（TypeScript）。
由上层直接调用，输入与结果只保存在内存中，无任何持久化与网络依赖。

本期范围：只判断 2 至 4 个版本的整体互动率是否存在差异，
不推荐获胜版本，不处理指标采集。

## 使用

```ts
import { compareVariants } from "narrativeflow-ab-exact";

const report = compareVariants([
  { exposure: 12000, engaged: 220 },
  { exposure: 18000, engaged: 375 },
  { exposure: 27000, engaged: 510 },
  { exposure: 43000, engaged: 895 },
]);
// report = { chiSquare, pValue, significant }
```

- `chiSquare`：Pearson 卡方统计量（互动 / 未互动两类）。
- `pValue`：精确 p 值（见下文定义），绝对误差 ≤ 1e-10。
- `significant`：精确 p 值 ≤ 0.05 时为 `true`（恰好 0.05 也算显著，
  不做展示位四舍五入）。

输入校验：版本数 2–4、曝光为正整数、互动人数介于 0 与曝光人数之间，
否则抛出 `Error`。全无互动或全部互动时返回 `{ chiSquare: 0, pValue: 1 }`。

## 数学定义

固定各版本曝光 `n_i` 与总互动人数 `M`，在互动机会相同的假设下，
计数表服从多重超几何分布：

```
P(table) = prod_i C(n_i, x_i) / C(N, M)
```

p 值 = 所有 Pearson 卡方统计量 ≥ 观察统计量（含相等）的计数表的概率之和。

## 实现要点

- 统计量化为逐版本可加形式 `Σ (x_i − n_i·p)² / (n_i·p·(1−p))`，
  版本按 2+2（或更少）拆半：第一半按互动数分桶、桶内按统计量排序并求
  权重后缀和；第二半流式枚举并二分查找累加（中途相遇）。
- 互动 / 未互动对称，始终枚举总数 ≤ 2000 的少数类。
- 组合数对数取自 Neumaier 补偿求和的 log 阶乘表，权重汇总使用
  最大值缩放，保证 p 值绝对误差 ≤ 1e-10、结果可重复。
- 规模上限（总曝光 ≤ 100000、少数类总数 ≤ 2000）下：
  单次计算约 0.3–0.5 s，峰值内存约 130 MiB（含 Node 运行时基线）。

## 测试与参考值

```sh
npm install
npm test
```

测试覆盖验收要求的全部场景；大样本案例的参考 p 值
`0.13903372762235364` 由 `tools/reference_pvalue.py` 生成——
那是一份独立实现（mpmath 80 位精度计算组合数对数、`math.fsum`
精确求和、两种拆半方式交叉验证一致到 6e-15），
小样本案例另由测试内暴力枚举直接按定义复核。
