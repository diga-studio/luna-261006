import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, type Batch } from "../src/allocate.js";

/** 穷举参考：在所有满足约束的矩阵中返回 (obj1, obj2) 的字典序最小值，单位 1/10000 分。 */
function bruteForceOptimum(batch: Batch): [bigint, bigint] {
  const subjects = batch.subjects;
  const deptIds: string[] = [];
  for (const s of subjects) {
    for (const d of Object.keys(s.weights)) {
      if (!deptIds.includes(d)) deptIds.push(d);
    }
  }
  const n = subjects.length;
  const m = deptIds.length;
  // idealNum[i][j] = amount * weight（即理想金额的 10000 倍）
  const idealNum: bigint[][] = subjects.map((s) =>
    deptIds.map((d) => s.amount * BigInt(s.weights[d] ?? 0)),
  );
  const colIdealNum: bigint[] = new Array<bigint>(m).fill(0n);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) colIdealNum[j] += idealNum[i][j];
  }
  // 每个格子的候选值：floor 或 ceil（整数时唯一）
  const choices: bigint[][][] = idealNum.map((row) =>
    row.map((num) => {
      const f = num / 10000n;
      return num % 10000n === 0n ? [f] : [f, f + 1n];
    }),
  );

  let best: [bigint, bigint] | null = null;
  const x: bigint[][] = Array.from({ length: n }, () => new Array<bigint>(m).fill(0n));
  const abs = (v: bigint) => (v < 0n ? -v : v);

  function consider(): void {
    // 部门合计约束 + 目标
    let obj1 = 0n;
    for (let j = 0; j < m; j++) {
      let total = 0n;
      for (let i = 0; i < n; i++) total += x[i][j];
      const scaled = total * 10000n;
      const lo = (colIdealNum[j] / 10000n) * 10000n;
      if (scaled !== colIdealNum[j] && scaled !== lo && scaled !== lo + 10000n) return;
      obj1 += abs(scaled - colIdealNum[j]);
    }
    let obj2 = 0n;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) obj2 += abs(x[i][j] * 10000n - idealNum[i][j]);
    }
    if (best === null || obj1 < best[0] || (obj1 === best[0] && obj2 < best[1])) {
      best = [obj1, obj2];
    }
  }

  function walkRow(i: number, j: number, remaining: bigint): void {
    if (j === m) {
      if (remaining !== 0n) return;
      if (i === n - 1) consider();
      else walkRow(i + 1, 0, subjects[i + 1].amount);
      return;
    }
    for (const v of choices[i][j]) {
      if (v > remaining) continue;
      x[i][j] = v;
      walkRow(i, j + 1, remaining - v);
    }
    x[i][j] = 0n;
  }
  if (n > 0) walkRow(0, 0, subjects[0].amount);
  if (best === null) throw new Error("brute force found no feasible solution");
  return best;
}

/** 计算 allocate 结果的 (obj1, obj2)，并顺带校验全部硬约束。 */
function evaluate(batch: Batch): [bigint, bigint] {
  const { matrix, departmentTotals } = allocate(batch);
  const subjects = batch.subjects;
  const deptIds: string[] = [];
  for (const s of subjects) {
    for (const d of Object.keys(s.weights)) {
      if (!deptIds.includes(d)) deptIds.push(d);
    }
  }
  const abs = (v: bigint) => (v < 0n ? -v : v);
  let obj2 = 0n;
  const colScaled = new Map<string, bigint>();
  const colIdeal = new Map<string, bigint>();
  for (const d of deptIds) {
    colScaled.set(d, 0n);
    colIdeal.set(d, 0n);
  }
  for (const s of subjects) {
    let rowSum = 0n;
    for (const d of deptIds) {
      const w = BigInt(s.weights[d] ?? 0);
      const idealNum = s.amount * w;
      const v = matrix[s.id]?.[d];
      assert.ok(v !== undefined, `missing cell ${s.id}/${d}`);
      // 单格 floor/ceil 约束
      const f = idealNum / 10000n;
      if (idealNum % 10000n === 0n) assert.equal(v, f, "integer ideal must not change");
      else assert.ok(v === f || v === f + 1n, `cell ${s.id}/${d} out of floor/ceil range`);
      if (w === 0n) assert.equal(v, 0n, "zero weight must get zero");
      rowSum += v;
      obj2 += abs(v * 10000n - idealNum);
      colScaled.set(d, colScaled.get(d)! + v * 10000n);
      colIdeal.set(d, colIdeal.get(d)! + idealNum);
    }
    assert.equal(rowSum, s.amount, `row ${s.id} must sum to amount`);
  }
  let obj1 = 0n;
  let totalSum = 0n;
  for (const d of deptIds) {
    const scaled = colScaled.get(d)!;
    const ideal = colIdeal.get(d)!;
    const lo = (ideal / 10000n) * 10000n;
    assert.ok(
      scaled === ideal || scaled === lo || scaled === lo + 10000n,
      `department ${d} total out of floor/ceil range`,
    );
    obj1 += abs(scaled - ideal);
    totalSum += departmentTotals[d];
    assert.equal(departmentTotals[d], scaled / 10000n, "departmentTotals must match matrix");
  }
  assert.equal(
    totalSum,
    subjects.reduce((a, s) => a + s.amount, 0n),
    "grand total must match",
  );
  return [obj1, obj2];
}

/** 可复现的伪随机数（LCG）。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** 随机生成权重向量（含零权重），合计 10000。 */
function randomWeights(rand: () => number, m: number): number[] {
  for (;;) {
    const w = Array.from({ length: m }, () => Math.floor(rand() * 5000));
    if (rand() < 0.4) w[Math.floor(rand() * m)] = 0; // 制造零权重
    const sum = w.reduce((a, b) => a + b, 0);
    if (sum === 0 || sum > 10000) continue;
    w[0] += 10000 - sum;
    if (w[0] < 0) continue;
    return w;
  }
}

test("互不相交的可分摊部门：余数大的科目不能挤占其他科目的进位", () => {
  const batch: Batch = {
    subjects: [
      { id: "s1", amount: 1n, weights: { A: 3400, B: 3300, C: 3300, D: 0, E: 0, F: 0 } },
      { id: "s2", amount: 2n, weights: { A: 0, B: 0, C: 0, D: 4500, E: 2750, F: 2750 } },
    ],
  };
  const { matrix, departmentTotals } = allocate(batch);
  // s1 的 1 分必须落在 A/B/C 中（理想 0.34/0.33/0.33，进位给 A 误差最小）
  assert.equal(matrix["s1"]!["A"], 1n);
  assert.equal(matrix["s1"]!["B"], 0n);
  assert.equal(matrix["s1"]!["C"], 0n);
  // s2 的 2 分必须落在 D/E/F 中，D 必进位（理想 0.9）
  assert.equal(matrix["s2"]!["D"], 1n);
  assert.equal(matrix["s2"]!["E"]! + matrix["s2"]!["F"]!, 1n);
  assert.equal(departmentTotals["A"], 1n);
  assert.equal(departmentTotals["D"], 1n);
  // 与穷举参考比对两级最优值
  assert.deepEqual(evaluate(batch), bruteForceOptimum(batch));
});

test("小实例穷举对拍：随机权重（含零权重）", () => {
  const rand = lcg(20261006);
  for (let t = 0; t < 300; t++) {
    const n = 1 + Math.floor(rand() * 4);
    const m = 1 + Math.floor(rand() * 4);
    const deptIds = Array.from({ length: m }, (_, j) => `d${j}`);
    const batch: Batch = {
      subjects: Array.from({ length: n }, (_, i) => {
        const w = randomWeights(rand, m);
        const weights: Record<string, number> = {};
        deptIds.forEach((d, j) => (weights[d] = w[j]!));
        return { id: `s${i}`, amount: BigInt(Math.floor(rand() * 21)), weights };
      }),
    };
    assert.deepEqual(evaluate(batch), bruteForceOptimum(batch), `case ${t}: ${JSON.stringify(batch, (_, v) => (typeof v === "bigint" ? Number(v) : v))}`);
  }
});

test("小实例穷举对拍：小金额小权重，密集覆盖整数理想金额", () => {
  const rand = lcg(1234567);
  for (let t = 0; t < 300; t++) {
    const n = 1 + Math.floor(rand() * 3);
    const m = 1 + Math.floor(rand() * 3);
    const deptIds = Array.from({ length: m }, (_, j) => `d${j}`);
    const batch: Batch = {
      subjects: Array.from({ length: n }, (_, i) => {
        // 从 {0, 2500, 5000, 7500, 10000} 中凑合计 10000，理想金额常为整数
        const parts = [0, 2500, 5000, 7500];
        const weights: Record<string, number> = {};
        let remaining = 10000;
        deptIds.forEach((d, j) => {
          const w = j === m - 1 ? remaining : parts[Math.floor(rand() * parts.length)]!;
          weights[d] = Math.min(w, remaining);
          remaining -= weights[d]!;
        });
        return { id: `s${i}`, amount: BigInt(Math.floor(rand() * 9)), weights };
      }),
    };
    assert.deepEqual(evaluate(batch), bruteForceOptimum(batch), `case ${t}`);
  }
});

test("部门误差并列时，选择单格误差更小的解", () => {
  // 两个科目在两个部门间镜像：部门误差相同的候选解有多个，单格误差可区分。
  const batch: Batch = {
    subjects: [
      { id: "s1", amount: 1n, weights: { A: 6000, B: 4000 } },
      { id: "s2", amount: 1n, weights: { A: 4000, B: 6000 } },
    ],
  };
  // 理想：s1->A 0.6, s1->B 0.4, s2->A 0.4, s2->B 0.6；列理想合计均为 1.0（整数）。
  // 唯一满足列合计恰为 1 的解：每列恰进位一次。两种选法部门误差都是 0，
  // 单格误差：进位 s1A+s2B => (0.4+0.4)+(0.4+0.4)=1.6；进位 s1B+s2A => 0.6*4=2.4。
  const { matrix } = allocate(batch);
  assert.equal(matrix["s1"]!["A"], 1n);
  assert.equal(matrix["s2"]!["B"], 1n);
  assert.deepEqual(evaluate(batch), bruteForceOptimum(batch));
});

test("理想金额为整数时不得改动", () => {
  const batch: Batch = {
    subjects: [
      { id: "s1", amount: 4n, weights: { A: 5000, B: 5000 } },
      { id: "s2", amount: 3n, weights: { A: 10000, B: 0 } },
    ],
  };
  const { matrix, departmentTotals } = allocate(batch);
  assert.equal(matrix["s1"]!["A"], 2n);
  assert.equal(matrix["s1"]!["B"], 2n);
  assert.equal(matrix["s2"]!["A"], 3n);
  assert.equal(matrix["s2"]!["B"], 0n);
  assert.equal(departmentTotals["A"], 5n);
  assert.equal(departmentTotals["B"], 2n);
  assert.deepEqual(evaluate(batch), bruteForceOptimum(batch));
});

test("空批次与零金额", () => {
  assert.deepEqual(allocate({ subjects: [] }), { matrix: {}, departmentTotals: {} });
  const batch: Batch = {
    subjects: [{ id: "s1", amount: 0n, weights: { A: 7000, B: 3000 } }],
  };
  const { matrix, departmentTotals } = allocate(batch);
  assert.equal(matrix["s1"]!["A"], 0n);
  assert.equal(matrix["s1"]!["B"], 0n);
  assert.equal(departmentTotals["A"], 0n);
  assert.equal(departmentTotals["B"], 0n);
});
