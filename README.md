# narrativeflow-ab-exact

NarrativeFlow 多版本 A/B 显著性计算库（TypeScript）。由上层直接调用，输入与结果只保存在内存中。

对 2 至 4 个文案版本的「曝光人数 / 至少互动一次人数」做整体差异检验：输出 Pearson 卡方统计量、精确 p 值（Fisher-Freeman-Halton 风格，按卡方统计量排序）与是否显著。本期只判断整体是否存在差异，不推荐获胜版本。

## 使用

```ts
import { compareVariants } from "narrativeflow-ab-exact";

const report = compareVariants([
  { exposure: 12000, converted: 220 },
  { exposure: 18000, converted: 375 },
  { exposure: 27000, converted: 510 },
  { exposure: 43000, converted: 895 },
]);
// report = { chiSquare, pValue, significant, alpha, totalExposure, totalConverted }
```

- `compareVariants(variants, options?)`：`variants` 为 2 至 4 个 `{ exposure, converted }`；`options.alpha` 默认 0.05。
- 输入不合法（数量、整数性、取值范围、超出支持规模）时抛出 `RangeError`。
- 支持规模：总曝光 ≤ 100000，且 min(总互动, 总未互动) ≤ 2000。
- 显著性判定：精确 p 值 ≤ alpha 即显著（恰好等于也算），不做展示位四舍五入；为吸收浮点求和的末位误差，判定带 1e-12 容差。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js（>= 18）与 devDependencies 中的 typescript / @types/node，无运行时依赖。

## 方法

- 统计量：2 x k 列联表 Pearson 卡方。版本 i 的贡献化简为
  `(x_i*N - n_i*K)^2 / (n_i*K*(N-K))`，全部版本相加。
- 精确 p 值：固定各版本曝光 n_i 与总互动 K，计数表概率为
  `prod C(n_i, x_i) / C(N, K)`；p 值为所有统计量 ≥ 观察统计量的表的概率之和（等值计入）。
- 互动/未互动互换不改变统计量与表概率分布，统一交换到 K ≤ N/2 一侧枚举。
- 算法：版本分两组，B 组按互动数分桶、桶内按统计量排序并预置权重后缀和；A 组逐表枚举、二分查找累加。组合数 C(n, x) 可能超过 float64 范围，全程用 log 权重 + 分桶归一化，因子均 ≤ 1，不会上溢。
- 等值边界：浮点比较带 1e-9 相对容差窗口，窗口内的表用 BigInt 精确比较
  `sum (x_i*N - n_i*K)^2 / n_i`（与卡方只差正常数因子），保证等统计量的表恰好计入。
- 退化规则：总互动为 0 或等于总曝光时，统计量为 0、p 值为 1。

## 精度与性能

- p 值绝对误差 ≤ 1e-10（实测对精确分数参考的偏差 ≤ 4e-15）；同一输入结果逐位可重复。
- 上限规模（总曝光 100000、min(互动, 未互动) = 2000、四版本不均衡）单次约 0.25–0.35 s，峰值内存约 140 MiB（含 Node 运行时基线），满足 5 s / 256 MiB 要求。

## 参考值与复核

- `reference/compute_reference.py`：仅用 Python 标准库的精确参考实现（`math.comb` 精确大整数 + `Fraction`），输出存档于 `reference/reference_output.txt`。
  - 4×2 小case：p = 3/35；1v19 小case：p = 1/20（精确分数全枚举，亦可手算）。
  - 大case（12000/18000/27000/43000，互动 220/375/510/895）：chi2 = 5.4926040183515266…，p = 0.13903372762225861554…（精确分数的十进制展开）。
- `reference/crosscheck_random.py` + `reference/crosscheck_random.mjs`：19 个随机/极端小case与精确分数全枚举交叉验证（需本机有 Python 3，不属于 `npm test`）。
