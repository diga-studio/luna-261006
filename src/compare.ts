import { exactTest } from "./exactTest";
import type { ComparisonReport, VariantInput } from "./types";

/** 显著性阈值：精确 p 值 <= 0.05 判为显著（恰好 0.05 也算显著）。 */
export const SIGNIFICANCE_LEVEL = 0.05;

/**
 * 判定阈值附近的浮点容差。
 * p 值本身有不超过 1e-10 的数值误差，恰好等于 0.05 的真值可能算出
 * 略大于 0.05 的浮点结果；按业务规则“恰好 0.05 也算显著”，
 * 在 1e-10 误差预算内视为达标。
 */
const SIGNIFICANCE_TOLERANCE = 1e-10;

/**
 * 比较 2 至 4 个版本，输出整体差异显著性报告。
 * 输入不合法（版本数越界、曝光非正整数、互动人数越界）时抛出 Error。
 */
export function compareVariants(variants: readonly VariantInput[]): ComparisonReport {
  validateVariants(variants);
  const { chiSquare, pValue } = exactTest(variants);
  return {
    chiSquare,
    pValue,
    significant: pValue <= SIGNIFICANCE_LEVEL + SIGNIFICANCE_TOLERANCE,
  };
}

function validateVariants(variants: readonly VariantInput[]): void {
  if (!Array.isArray(variants) || variants.length < 2 || variants.length > 4) {
    throw new Error("一次比较需要 2 至 4 个版本");
  }
  variants.forEach((v, i) => {
    if (!Number.isInteger(v.exposure) || v.exposure <= 0) {
      throw new Error(`版本 ${i} 的曝光人数必须是正整数`);
    }
    if (!Number.isInteger(v.engaged) || v.engaged < 0 || v.engaged > v.exposure) {
      throw new Error(`版本 ${i} 的互动人数必须介于 0 和曝光人数之间`);
    }
  });
}
