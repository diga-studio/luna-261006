import { describe, test } from "node:test";
import { ok } from "node:assert/strict";
import { compareVariants } from "../src/index";
import type { VariantInput } from "../src/index";

/**
 * 小样本暴力枚举交叉验证：直接按业务定义枚举全部计数表，
 * 用精确整数组合数计算每张表的概率并求和，与库结果对比。
 * 这是对“精确 p 值”定义本身的独立复核。
 */

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

function chiSquareOf(ns: readonly number[], xs: readonly number[]): number {
  const N = ns.reduce((a, b) => a + b, 0);
  const M = xs.reduce((a, b) => a + b, 0);
  if (M === 0 || M === N) return 0;
  const p = M / N;
  let chi2 = 0;
  for (let i = 0; i < ns.length; i += 1) {
    const diff = xs[i]! - ns[i]! * p;
    chi2 += (diff * diff) / (ns[i]! * p * (1 - p));
  }
  return chi2;
}

function bruteForceP(variants: readonly VariantInput[]): number {
  const ns = variants.map((v) => v.exposure);
  const xs = variants.map((v) => v.engaged);
  const N = ns.reduce((a, b) => a + b, 0);
  const M = xs.reduce((a, b) => a + b, 0);
  if (M === 0 || M === N) return 1;
  const obs = chiSquareOf(ns, xs);
  const denom = comb(N, M);
  const k = ns.length;
  let numerator = 0;
  // 枚举所有 x_1..x_{k-1}，x_k 由总和 M 决定。
  const current = new Array<number>(k).fill(0);
  const visit = (i: number, remaining: number): void => {
    if (i === k - 1) {
      current[i] = remaining;
      if (remaining > ns[i]!) return;
      let weight = 1;
      for (let j = 0; j < k; j += 1) weight *= comb(ns[j]!, current[j]!);
      if (chiSquareOf(ns, current) >= obs * (1 - 1e-12) - 1e-15) {
        numerator += weight;
      }
      return;
    }
    for (let x = 0; x <= Math.min(ns[i]!, remaining); x += 1) {
      current[i] = x;
      visit(i + 1, remaining - x);
    }
  };
  visit(0, M);
  return numerator / denom;
}

const CASES: VariantInput[][] = [
  // 两版本
  [
    { exposure: 5, engaged: 4 },
    { exposure: 7, engaged: 2 },
  ],
  // 三版本，曝光不均衡
  [
    { exposure: 4, engaged: 3 },
    { exposure: 6, engaged: 1 },
    { exposure: 3, engaged: 2 },
  ],
  // 四版本
  [
    { exposure: 6, engaged: 5 },
    { exposure: 5, engaged: 2 },
    { exposure: 7, engaged: 3 },
    { exposure: 4, engaged: 1 },
  ],
  // 互动稀少（小计数、大样本近似的失效区）
  [
    { exposure: 30, engaged: 1 },
    { exposure: 25, engaged: 4 },
    { exposure: 28, engaged: 0 },
  ],
  // 互动人数接近曝光人数（触发少数类对称化路径）
  [
    { exposure: 8, engaged: 7 },
    { exposure: 9, engaged: 9 },
    { exposure: 6, engaged: 4 },
  ],
];

describe("小样本暴力枚举交叉验证", () => {
  CASES.forEach((variants, idx) => {
    test(`案例 ${idx + 1} 与暴力枚举一致`, () => {
      const r = compareVariants(variants);
      const expected = bruteForceP(variants);
      ok(
        Math.abs(r.pValue - expected) <= 1e-10,
        `pValue=${r.pValue} expected=${expected}`,
      );
    });
  });
});
