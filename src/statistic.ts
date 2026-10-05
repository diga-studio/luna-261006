import type { VariantInput } from "./types";

/**
 * Pearson 卡方统计量（互动 / 未互动两类）。
 *
 * 固定各版本曝光 n_i 与总互动 M 时，每格期望为 n_i * 类别总体占比，
 * 逐格 (O-E)^2/E 相加后可化为逐版本可加形式：
 *   chi2 = sum_i (x_i - n_i*p)^2 / (n_i * p * (1 - p)),  p = M / N。
 * 该形式与逐格定义在数学上完全等价，且便于在枚举计数表时增量计算。
 *
 * 退化情形（M = 0 或 M = N，即全无互动或全部互动）统计量定义为 0。
 */
export function pearsonChiSquare(variants: readonly VariantInput[]): number {
  let totalExposure = 0;
  let totalEngaged = 0;
  for (const v of variants) {
    totalExposure += v.exposure;
    totalEngaged += v.engaged;
  }
  if (totalEngaged === 0 || totalEngaged === totalExposure) {
    return 0;
  }
  const p = totalEngaged / totalExposure;
  const denomScale = p * (1 - p);
  let chi2 = 0;
  for (const v of variants) {
    const expected = v.exposure * p;
    const diff = v.engaged - expected;
    chi2 += (diff * diff) / (v.exposure * denomScale);
  }
  return chi2;
}
