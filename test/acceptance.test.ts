import { describe, test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { compareVariants } from "../src/index";
import type { VariantInput } from "../src/index";

const P_TOLERANCE = 1e-10;

function permute<T>(arr: readonly T[], order: readonly number[]): T[] {
  return order.map((i) => arr[i]!);
}

describe("验收案例 1：四版本各曝光 2 人，互动 2/2/0/0", () => {
  // 数学依据：N=8, M=4，分母 C(8,4)=70。观察表 (2,2,0,0) 的统计量最大，
  // 与其并列的表是两个“全互动版本”在 4 个版本中的全部 C(4,2)=6 种位置，
  // 每张表权重 C(2,2)C(2,2)C(2,0)C(2,0)=1，故 p = 6/70 = 3/35。
  const variants: VariantInput[] = [
    { exposure: 2, engaged: 2 },
    { exposure: 2, engaged: 2 },
    { exposure: 2, engaged: 0 },
    { exposure: 2, engaged: 0 },
  ];

  test("精确 p 值等于 3/35，统计量等于 8，结论不显著", () => {
    const r = compareVariants(variants);
    ok(Math.abs(r.pValue - 3 / 35) <= P_TOLERANCE, `pValue=${r.pValue}`);
    ok(Math.abs(r.chiSquare - 8) <= 1e-12, `chiSquare=${r.chiSquare}`);
    equal(r.significant, false);
  });

  test("调换版本顺序后统计量、p 值及结论不变", () => {
    const base = compareVariants(variants);
    const orders = [
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [1, 3, 0, 2],
      [2, 3, 0, 1],
    ];
    for (const order of orders) {
      const r = compareVariants(permute(variants, order));
      ok(Math.abs(r.chiSquare - base.chiSquare) <= 1e-9, `chiSquare=${r.chiSquare}`);
      ok(Math.abs(r.pValue - base.pValue) <= 1e-9, `pValue=${r.pValue}`);
      equal(r.significant, base.significant);
    }
  });
});

describe("验收案例 2：两版本曝光 1/19，互动 1/0", () => {
  // 数学依据：N=20, M=1，唯一的互动者等可能落在 20 个曝光位上。
  // 观察表要求落在曝光 1 人的版本，概率 C(1,1)C(19,0)/C(20,1) = 1/20，
  // 且该表统计量严格最大，故 p = 1/20 = 0.05，恰好等于阈值，判显著。
  const variants: VariantInput[] = [
    { exposure: 1, engaged: 1 },
    { exposure: 19, engaged: 0 },
  ];

  test("精确 p 值等于 1/20，恰好 0.05 判为显著", () => {
    const r = compareVariants(variants);
    ok(Math.abs(r.pValue - 1 / 20) <= P_TOLERANCE, `pValue=${r.pValue}`);
    equal(r.significant, true);
  });

  test("互动人数替换为未互动人数后结果不变", () => {
    const swapped: VariantInput[] = variants.map((v) => ({
      exposure: v.exposure,
      engaged: v.exposure - v.engaged,
    }));
    const base = compareVariants(variants);
    const r = compareVariants(swapped);
    ok(Math.abs(r.chiSquare - base.chiSquare) <= 1e-12);
    ok(Math.abs(r.pValue - base.pValue) <= 1e-12);
    equal(r.significant, base.significant);
  });

  test("全无互动与全部互动符合退化规则", () => {
    const none = compareVariants([
      { exposure: 1, engaged: 0 },
      { exposure: 19, engaged: 0 },
    ]);
    deepEqual(none, { chiSquare: 0, pValue: 1, significant: false });
    const all = compareVariants([
      { exposure: 1, engaged: 1 },
      { exposure: 19, engaged: 19 },
    ]);
    deepEqual(all, { chiSquare: 0, pValue: 1, significant: false });
  });
});

describe("验收案例 3：四版本大样本（12000/18000/27000/43000）", () => {
  const variants: VariantInput[] = [
    { exposure: 12000, engaged: 220 },
    { exposure: 18000, engaged: 375 },
    { exposure: 27000, engaged: 510 },
    { exposure: 43000, engaged: 895 },
  ];
  // 参考 p 值来源：tools/reference_pvalue.py（独立实现，mpmath 80 位精度
  // 计算组合数对数 + math.fsum 精确求和，两种一半划分交叉验证一致到 6e-15）。
  const REFERENCE_P = 0.13903372762235364;

  test("统计量、p 值精度、耗时与内存满足要求", () => {
    if (global.gc) global.gc();
    const rssBefore = process.memoryUsage().rss;
    const t0 = Date.now();
    const r = compareVariants(variants);
    const elapsedMs = Date.now() - t0;
    const rssAfter = process.memoryUsage().rss;

    ok(Math.abs(r.chiSquare - 5.492604018351527) <= 1e-12, `chiSquare=${r.chiSquare}`);
    ok(Math.abs(r.pValue - REFERENCE_P) <= P_TOLERANCE, `pValue=${r.pValue}`);
    equal(r.significant, false);
    ok(elapsedMs < 5000, `elapsed=${elapsedMs}ms`);
    ok(rssAfter - rssBefore < 256 * 1024 * 1024, `rssDelta=${rssAfter - rssBefore}`);
  });

  test("同一输入结果可重复", () => {
    const a = compareVariants(variants);
    const b = compareVariants(variants);
    deepEqual(a, b);
  });
});

describe("输入校验", () => {
  const ok2: VariantInput[] = [
    { exposure: 10, engaged: 3 },
    { exposure: 10, engaged: 4 },
  ];
  test("版本数必须为 2 至 4", () => {
    throws(() => compareVariants([ok2[0]!]));
    throws(() => compareVariants([...ok2, ...ok2, ok2[0]!]));
    throws(() => compareVariants([]));
  });
  test("曝光人数必须是正整数", () => {
    throws(() => compareVariants([{ exposure: 0, engaged: 0 }, ok2[1]!]));
    throws(() => compareVariants([{ exposure: 2.5, engaged: 1 }, ok2[1]!]));
    throws(() => compareVariants([{ exposure: -3, engaged: 0 }, ok2[1]!]));
  });
  test("互动人数必须介于 0 和曝光人数之间", () => {
    throws(() => compareVariants([{ exposure: 10, engaged: 11 }, ok2[1]!]));
    throws(() => compareVariants([{ exposure: 10, engaged: -1 }, ok2[1]!]));
    throws(() => compareVariants([{ exposure: 10, engaged: 1.5 }, ok2[1]!]));
  });
});
