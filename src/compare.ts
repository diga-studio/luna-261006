import { exactPValue } from "./exact.js";
import { chiSquareStatistic } from "./statistic.js";
import type { CompareOptions, ComparisonReport, VariantInput } from "./types.js";

/** 支持的总曝光上限。 */
export const MAX_TOTAL_EXPOSURE = 100000;
/** 支持的 min(总互动, 总未互动) 上限。 */
export const MAX_MIN_CLASS_TOTAL = 2000;
/** 默认显著性水平。 */
export const DEFAULT_ALPHA = 0.05;

/**
 * 判定显著时的数值容差：精确 p 值恰好等于 alpha（如 1/20）时，
 * 浮点求和可能有最后几位的误差，容差内视为相等（即显著）。
 * 不做任何按展示位数的四舍五入。
 */
const ALPHA_TOL = 1e-12;

function validate(variants: VariantInput[]): void {
  if (!Array.isArray(variants) || variants.length < 2 || variants.length > 4) {
    throw new RangeError(`需要 2 至 4 个版本，实际为 ${Array.isArray(variants) ? variants.length : typeof variants}`);
  }
  let totalExposure = 0;
  let totalConverted = 0;
  for (const v of variants) {
    if (!Number.isInteger(v.exposure) || v.exposure < 1) {
      throw new RangeError(`曝光人数必须为正整数，实际为 ${v.exposure}`);
    }
    if (!Number.isInteger(v.converted) || v.converted < 0 || v.converted > v.exposure) {
      throw new RangeError(`互动人数必须为 [0, 曝光人数] 内的整数，实际为 ${v.converted}（曝光 ${v.exposure}）`);
    }
    totalExposure += v.exposure;
    totalConverted += v.converted;
  }
  if (totalExposure > MAX_TOTAL_EXPOSURE) {
    throw new RangeError(`总曝光人数 ${totalExposure} 超过支持上限 ${MAX_TOTAL_EXPOSURE}`);
  }
  const minor = Math.min(totalConverted, totalExposure - totalConverted);
  if (minor > MAX_MIN_CLASS_TOTAL) {
    throw new RangeError(`互动与未互动总人数的较小值 ${minor} 超过支持上限 ${MAX_MIN_CLASS_TOTAL}`);
  }
}

/** 比较 2 至 4 个版本，返回整体差异的精确显著性报告。 */
export function compareVariants(
  variants: VariantInput[],
  options?: CompareOptions,
): ComparisonReport {
  validate(variants);
  const alpha = options?.alpha ?? DEFAULT_ALPHA;
  if (!(alpha > 0 && alpha < 1)) {
    throw new RangeError(`显著性水平必须在 (0, 1) 内，实际为 ${alpha}`);
  }

  const exposures = variants.map((v) => v.exposure);
  let converted = variants.map((v) => v.converted);
  const totalExposure = exposures.reduce((a, b) => a + b, 0);
  const totalConverted = converted.reduce((a, b) => a + b, 0);

  // 退化规则：全无互动或全部互动时统计量为 0、p 值为 1。
  if (totalConverted === 0 || totalConverted === totalExposure) {
    return {
      chiSquare: 0,
      pValue: 1,
      significant: false,
      alpha,
      totalExposure,
      totalConverted,
    };
  }

  // 互动/未互动互换不改变卡方统计量与计数表概率分布，
  // 统一交换到 K <= N/2 一侧，使枚举规模受 min(K, N-K) 约束。
  if (totalConverted > totalExposure - totalConverted) {
    converted = exposures.map((n, i) => n - converted[i]);
  }

  const chiSquare = chiSquareStatistic(exposures, converted);
  const pValue = exactPValue(exposures, converted, chiSquare);
  const significant = pValue <= alpha || pValue - alpha <= ALPHA_TOL;

  return {
    chiSquare,
    pValue,
    significant,
    alpha,
    totalExposure,
    totalConverted,
  };
}
