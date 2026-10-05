/**
 * Pearson 卡方统计量。
 *
 * 对 2 x k 列联表（互动/未互动两类），版本 i 曝光 n_i、互动 x_i，
 * 总曝光 N、总互动 K。两格贡献合并后可化简为：
 *   c_i(x_i) = (x_i * N - n_i * K)^2 / (n_i * K * (N - K))
 * 统计量为全部版本贡献之和。
 *
 * 推导：期望 E = n_i*K/N，两格贡献
 *   (x-E)^2/E + ((n_i-x)-(n_i-E))^2/(n_i-E) = (x-E)^2 * n_i / (E*(n_i-E))
 * 代入即得上式。
 */

/** 计算观察表的 Pearson 卡方统计量。K 为 0 或 N（全未互动/全互动）时为 0。 */
export function chiSquareStatistic(exposures: number[], converted: number[]): number {
  let totalExposure = 0;
  let totalConverted = 0;
  for (let i = 0; i < exposures.length; i++) {
    totalExposure += exposures[i];
    totalConverted += converted[i];
  }
  const rest = totalExposure - totalConverted;
  if (totalConverted === 0 || rest === 0) {
    return 0;
  }
  const denominator = totalConverted * rest;
  let sum = 0;
  for (let i = 0; i < exposures.length; i++) {
    const d = converted[i] * totalExposure - exposures[i] * totalConverted;
    sum += (d * d) / (exposures[i] * denominator);
  }
  return sum;
}
