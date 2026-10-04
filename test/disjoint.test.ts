import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/index.ts";
import type { AllocationResult } from "../src/index.ts";

const BASIS = 10000n;

/** 部门合计绝对误差之和（放大 10000 倍）。 */
function departmentErrorSum(
  result: AllocationResult,
  ideals: Readonly<Record<string, bigint>>,
): bigint {
  let sum = 0n;
  for (const [dept, idealTimesBasis] of Object.entries(ideals)) {
    const actual = result.departmentTotals[dept]! * BASIS;
    sum += actual > idealTimesBasis ? actual - idealTimesBasis : idealTimesBasis - actual;
  }
  return sum;
}

/** 单格绝对误差之和（放大 10000 倍）。 */
function cellErrorSum(
  result: AllocationResult,
  ideals: Readonly<Record<string, Readonly<Record<string, bigint>>>>,
): bigint {
  let sum = 0n;
  for (const [subjectId, row] of Object.entries(ideals)) {
    for (const [dept, idealTimesBasis] of Object.entries(row)) {
      const actual = result.matrix[subjectId]![dept]! * BASIS;
      sum += actual > idealTimesBasis ? actual - idealTimesBasis : idealTimesBasis - actual;
    }
  }
  return sum;
}

test("两个科目的可分摊部门互不相交时，各自组内独立核平", () => {
  const result = allocate({
    subjects: [
      { id: "S1", amount: 1n, weights: { A: 3400, B: 3300, C: 3300 } },
      { id: "S2", amount: 2n, weights: { D: 4500, E: 2750, F: 2750 } },
    ],
  });

  // 每个科目的实际分摊合计恰好等于科目金额。
  const s1 = result.matrix["S1"]!;
  const s2 = result.matrix["S2"]!;
  assert.equal(s1["A"]! + s1["B"]! + s1["C"]!, 1n);
  assert.equal(s2["D"]! + s2["E"]! + s2["F"]!, 2n);

  // 第一组只分到 1 分：不能因 D/E/F 余数更大就让 A/B/C 全部为 0；
  // 且 1 分必须给余数最大的 A（0.34 > 0.33 = 0.33）。
  assert.equal(s1["A"], 1n);
  assert.equal(s1["B"], 0n);
  assert.equal(s1["C"], 0n);

  // 第二组分到 2 分：D（0.9）必须进位，E/F（各 0.55）中恰有一个进位。
  assert.equal(s2["D"], 1n);
  assert.equal(s2["E"]! + s2["F"]!, 1n);

  // 部门合计与理想合计的下/上取整一致。
  assert.equal(result.departmentTotals["A"], 1n);
  assert.equal(result.departmentTotals["B"], 0n);
  assert.equal(result.departmentTotals["C"], 0n);
  assert.equal(result.departmentTotals["D"], 1n);
  assert.ok(
    (result.departmentTotals["E"] === 1n && result.departmentTotals["F"] === 0n) ||
    (result.departmentTotals["E"] === 0n && result.departmentTotals["F"] === 1n),
  );

  // 核验两级最优误差（放大 10000 倍）：
  // 部门误差 = 0.66+0.33+0.33 + 0.10+0.45+0.55 = 2.42
  const deptIdeals = {
    A: 3400n, B: 3300n, C: 3300n,
    D: 9000n, E: 5500n, F: 5500n,
  };
  assert.equal(departmentErrorSum(result, deptIdeals), 24200n);

  // 单格误差 = (0.66+0.33+0.33) + (0.10+0.45+0.55) = 2.42
  const cellIdeals = {
    S1: { A: 3400n, B: 3300n, C: 3300n },
    S2: { D: 9000n, E: 5500n, F: 5500n },
  };
  assert.equal(cellErrorSum(result, cellIdeals), 24200n);
});
