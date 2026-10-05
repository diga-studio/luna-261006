import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { compareVariants } from "../src/index.js";

// 参考值来源：reference/compute_reference.py（仅 Python 标准库，精确大整数/分数运算，
// 数学依据见文件头注释），输出存档于 reference/reference_output.txt：
//   chi2 = 5.4926040183515266（float64 最近值）
//   p = 0.1390337276222586155401485993792388612065...（精确分数的十进制展开）
const REF_CHI2 = 5.492604018351527;
const REF_P = 0.1390337276222586155401485993792388612065;

test("四版本不均衡大样本：统计量与精确p值满足误差、耗时要求", () => {
  const start = performance.now();
  const r = compareVariants([
    { exposure: 12000, converted: 220 },
    { exposure: 18000, converted: 375 },
    { exposure: 27000, converted: 510 },
    { exposure: 43000, converted: 895 },
  ]);
  const elapsedMs = performance.now() - start;

  assert.ok(
    Math.abs(r.chiSquare - REF_CHI2) <= 1e-12,
    `chiSquare=${r.chiSquare}`,
  );
  assert.ok(
    Math.abs(r.pValue - REF_P) <= 1e-10,
    `pValue=${r.pValue}, ref=${REF_P}, |diff|=${Math.abs(r.pValue - REF_P)}`,
  );
  assert.equal(r.significant, false);
  assert.ok(elapsedMs < 5000, `耗时 ${elapsedMs.toFixed(0)}ms 超过 5s`);
  console.log(
    `    大case: chi2=${r.chiSquare}, p=${r.pValue}, 耗时=${elapsedMs.toFixed(0)}ms`,
  );
});

test("同一输入重复计算结果逐位一致", () => {
  const vs = [
    { exposure: 12000, converted: 220 },
    { exposure: 18000, converted: 375 },
    { exposure: 27000, converted: 510 },
    { exposure: 43000, converted: 895 },
  ];
  const r0 = compareVariants(vs);
  const r1 = compareVariants(vs);
  assert.equal(r1.chiSquare, r0.chiSquare);
  assert.equal(r1.pValue, r0.pValue);
});
