import assert from "node:assert/strict";
import test from "node:test";
import { compareVariants } from "../src/index.js";

// 参考值来源：reference/compute_reference.py 的精确分数全枚举（数学依据见该文件），
// 其中 p=3/35 与 p=1/20 也可直接手算验证：
// - 4x2 表：C(8,4)=70 张等权分子中，卡方>=8 的表为两张互动数取 {0,2} 且和为 4 的 6 张，
//   每张概率 1/70，p=6/70=3/35。
// - 1v19 表：C(20,1)=20，观察表 (1,0) 的卡方为 20 为最大值之一，仅该表达到，p=1/20。

test("四个版本各曝光2人，互动2,2,0,0：p=3/35，不显著", () => {
  const r = compareVariants([
    { exposure: 2, converted: 2 },
    { exposure: 2, converted: 2 },
    { exposure: 2, converted: 0 },
    { exposure: 2, converted: 0 },
  ]);
  assert.equal(r.chiSquare, 8);
  assert.ok(Math.abs(r.pValue - 3 / 35) <= 1e-15, `p=${r.pValue}`);
  assert.equal(r.significant, false);
});

test("调换版本顺序后统计量、p值、结论不变", () => {
  const base = [
    { exposure: 2, converted: 2 },
    { exposure: 2, converted: 2 },
    { exposure: 2, converted: 0 },
    { exposure: 2, converted: 0 },
  ];
  const r0 = compareVariants(base);
  // 所有权重都是 2 的幂，浮点求和精确，排列后结果应逐位一致。
  for (const perm of [
    [base[2], base[3], base[0], base[1]],
    [base[0], base[2], base[1], base[3]],
    [base[3], base[1], base[2], base[0]],
  ]) {
    const r = compareVariants(perm);
    assert.equal(r.chiSquare, r0.chiSquare);
    assert.equal(r.pValue, r0.pValue);
    assert.equal(r.significant, r0.significant);
  }
});

test("两个版本曝光1与19、互动1与0：p=1/20=0.05，恰好0.05判显著", () => {
  const r = compareVariants([
    { exposure: 1, converted: 1 },
    { exposure: 19, converted: 0 },
  ]);
  assert.equal(r.chiSquare, 20);
  assert.ok(Math.abs(r.pValue - 1 / 20) <= 1e-15, `p=${r.pValue}`);
  assert.equal(r.significant, true);
});

test("互动人数替换为未互动人数后结果不变", () => {
  const r0 = compareVariants([
    { exposure: 1, converted: 1 },
    { exposure: 19, converted: 0 },
  ]);
  const r1 = compareVariants([
    { exposure: 1, converted: 0 },
    { exposure: 19, converted: 19 },
  ]);
  assert.equal(r1.chiSquare, r0.chiSquare);
  assert.equal(r1.pValue, r0.pValue);
  assert.equal(r1.significant, r0.significant);
});

test("退化规则：全无互动 / 全部互动时统计量为0、p值为1、不显著", () => {
  const none = compareVariants([
    { exposure: 10, converted: 0 },
    { exposure: 20, converted: 0 },
    { exposure: 30, converted: 0 },
  ]);
  assert.equal(none.chiSquare, 0);
  assert.equal(none.pValue, 1);
  assert.equal(none.significant, false);

  const all = compareVariants([
    { exposure: 10, converted: 10 },
    { exposure: 20, converted: 20 },
  ]);
  assert.equal(all.chiSquare, 0);
  assert.equal(all.pValue, 1);
  assert.equal(all.significant, false);
});

test("三个版本的不均衡曝光精确比较（与精确分数枚举一致）", () => {
  // 手算验证：n=[3,5,4], x=[2,1,0], N=12, K=3。
  // 参考值由 reference/compute_reference.py 的 brute_force 复核：
  // chi2 = 188/45, p = 21/110。
  const r = compareVariants([
    { exposure: 3, converted: 2 },
    { exposure: 5, converted: 1 },
    { exposure: 4, converted: 0 },
  ]);
  assert.ok(Math.abs(r.chiSquare - 188 / 45) <= 1e-12, `chi2=${r.chiSquare}`);
  assert.ok(Math.abs(r.pValue - 21 / 110) <= 1e-12, `p=${r.pValue}`);
  assert.equal(r.significant, false);
});
