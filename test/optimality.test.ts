import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/index.ts";
import type {
  AllocationBatch,
  AllocationResult,
  ExpenseSubject,
} from "../src/index.ts";

const BASIS = 10000n;

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface IdealInfo {
  /** 每格下取整值 floorMatrix[s][d]。 */
  floors: bigint[][];
  /** 每格理想值（放大 10000 倍）= amount * weight。 */
  cellIdealScaled: bigint[][];
  /** 每个部门理想合计（放大 10000 倍）。 */
  deptIdealScaled: bigint[];
  /** 每个部门合计允许的下界与上界（分）。 */
  deptLow: bigint[];
  deptHigh: bigint[];
  departmentIds: string[];
}

function analyze(batch: AllocationBatch): IdealInfo {
  const departmentIds: string[] = [];
  const seen = new Set<string>();
  for (const subject of batch.subjects) {
    for (const dept of Object.keys(subject.weights)) {
      if (!seen.has(dept)) {
        seen.add(dept);
        departmentIds.push(dept);
      }
    }
  }
  const d = departmentIds.length;
  const floors: bigint[][] = [];
  const cellIdealScaled: bigint[][] = [];
  const deptIdealScaled: bigint[] = new Array<bigint>(d).fill(0n);
  for (const subject of batch.subjects) {
    const floorRow: bigint[] = [];
    const idealRow: bigint[] = [];
    for (const dept of departmentIds) {
      const scaled = subject.amount * BigInt(subject.weights[dept] ?? 0);
      idealRow.push(scaled);
      floorRow.push(scaled / BASIS);
      deptIdealScaled[departmentIds.indexOf(dept)] =
        deptIdealScaled[departmentIds.indexOf(dept)]! + scaled;
    }
    floors.push(floorRow);
    cellIdealScaled.push(idealRow);
  }
  const deptLow: bigint[] = [];
  const deptHigh: bigint[] = [];
  for (let j = 0; j < d; j++) {
    const ideal = deptIdealScaled[j]!;
    const low = ideal / BASIS;
    deptLow.push(low);
    deptHigh.push(ideal % BASIS === 0n ? low : low + 1n);
  }
  return { floors, cellIdealScaled, deptIdealScaled, deptLow, deptHigh, departmentIds };
}

/** 字典序比较两级误差。 */
function lexBetter(
  a: readonly [bigint, bigint],
  b: readonly [bigint, bigint],
): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/** 计算一个完整矩阵的两级误差（放大 10000 倍）。 */
function errorsOf(
  cells: bigint[][],
  info: IdealInfo,
): readonly [bigint, bigint] {
  let deptErr = 0n;
  let cellErr = 0n;
  const d = info.departmentIds.length;
  for (let j = 0; j < d; j++) {
    let total = 0n;
    for (const row of cells) total += row[j]!;
    const diff = total * BASIS - info.deptIdealScaled[j]!;
    deptErr += diff >= 0n ? diff : -diff;
  }
  for (let s = 0; s < cells.length; s++) {
    for (let j = 0; j < d; j++) {
      const diff = cells[s]![j]! * BASIS - info.cellIdealScaled[s]![j]!;
      cellErr += diff >= 0n ? diff : -diff;
    }
  }
  return [deptErr, cellErr] as const;
}

/** 从 allocate 的结果中提取矩阵（科目顺序 × 部门顺序）。 */
function matrixOf(
  result: AllocationResult,
  batch: AllocationBatch,
  departmentIds: string[],
): bigint[][] {
  return batch.subjects.map((subject) =>
    departmentIds.map((dept) => result.matrix[subject.id]![dept]!),
  );
}

/** 校验结果满足全部硬约束。 */
function assertFeasible(
  result: AllocationResult,
  batch: AllocationBatch,
  info: IdealInfo,
): void {
  const cells = matrixOf(result, batch, info.departmentIds);
  const d = info.departmentIds.length;
  for (let s = 0; s < batch.subjects.length; s++) {
    let rowSum = 0n;
    for (let j = 0; j < d; j++) {
      const floor = info.floors[s]![j]!;
      const value = cells[s]![j]!;
      // 单格只能是理想值向下或向上取整（理想为整数时不得改动）。
      assert.ok(
        value === floor || value === floor + 1n,
        `cell(${batch.subjects[s]!.id}, ${info.departmentIds[j]!}) = ${value} 越界`,
      );
      rowSum += value;
    }
    // 每个科目的实际分摊合计恰好等于科目金额。
    assert.equal(rowSum, batch.subjects[s]!.amount, `科目 ${batch.subjects[s]!.id} 未核平`);
  }
  for (let j = 0; j < d; j++) {
    let total = 0n;
    for (const row of cells) total += row[j]!;
    // 部门合计只能落在理想合计的下/上取整之间。
    assert.ok(
      total === info.deptLow[j]! || total === info.deptHigh[j]!,
      `部门 ${info.departmentIds[j]!} 合计 ${total} 越界`,
    );
    assert.equal(result.departmentTotals[info.departmentIds[j]!], total);
  }
}

/** 穷举全部合法矩阵，返回两级误差的字典序最小值。 */
function bruteForceOptimum(
  batch: AllocationBatch,
  info: IdealInfo,
): readonly [bigint, bigint] {
  const d = info.departmentIds.length;
  // 每个科目：余数 > 0 的格可向上取整，需选出 rowRoundUps 个。
  const choicesPerSubject: number[][][] = [];
  for (let s = 0; s < batch.subjects.length; s++) {
    const fractional: number[] = [];
    let floorSum = 0n;
    for (let j = 0; j < d; j++) {
      floorSum += info.floors[s]![j]!;
      if (info.cellIdealScaled[s]![j]! % BASIS !== 0n) fractional.push(j);
    }
    const roundUps = Number(batch.subjects[s]!.amount - floorSum);
    const combos: number[][] = [];
    const pick = (start: number, left: number, acc: number[]): void => {
      if (left === 0) {
        combos.push([...acc]);
        return;
      }
      for (let i = start; i <= fractional.length - left; i++) {
        acc.push(fractional[i]!);
        pick(i + 1, left - 1, acc);
        acc.pop();
      }
    };
    pick(0, roundUps, []);
    choicesPerSubject.push(combos);
  }

  let best: readonly [bigint, bigint] | null = null;
  const cells: bigint[][] = info.floors.map((row) => [...row]);
  const columnExtra: number[] = new Array<number>(d).fill(0);
  const visit = (s: number): void => {
    if (s === batch.subjects.length) {
      // 部门合计必须落在下/上取整范围内。
      for (let j = 0; j < d; j++) {
        let base = 0n;
        for (const row of info.floors) base += row[j]!;
        const total = base + BigInt(columnExtra[j]!);
        if (total < info.deptLow[j]! || total > info.deptHigh[j]!) return;
      }
      const errors = errorsOf(cells, info);
      if (best === null || lexBetter(errors, best)) best = errors;
      return;
    }
    for (const combo of choicesPerSubject[s]!) {
      for (const j of combo) {
        cells[s]![j] = cells[s]![j]! + 1n;
        columnExtra[j] = columnExtra[j]! + 1;
      }
      visit(s + 1);
      for (const j of combo) {
        cells[s]![j] = cells[s]![j]! - 1n;
        columnExtra[j] = columnExtra[j]! - 1;
      }
    }
  };
  visit(0);
  assert.ok(best !== null, "穷举未找到任何合法矩阵");
  return best;
}

function checkCase(batch: AllocationBatch, label: string): void {
  const info = analyze(batch);
  const result = allocate(batch);
  assertFeasible(result, batch, info);
  const optimum = bruteForceOptimum(batch, info);
  const actual = errorsOf(matrixOf(result, batch, info.departmentIds), info);
  assert.equal(
    actual[0],
    optimum[0],
    `${label}: 部门合计误差之和 ${actual[0]} 非最优 ${optimum[0]}`,
  );
  assert.equal(
    actual[1],
    optimum[1],
    `${label}: 单格误差之和 ${actual[1]} 非最优 ${optimum[1]}`,
  );
}

test("手工构造：零权重、整数理想值、部门误差相同但单格误差不同", () => {
  const cases: Array<[string, AllocationBatch]> = [
    [
      "部门误差并列、单格误差可区分",
      {
        subjects: [
          { id: "S1", amount: 1n, weights: { A: 6000, B: 4000 } },
          { id: "S2", amount: 1n, weights: { A: 4000, B: 6000 } },
        ],
      },
    ],
    [
      "全部理想值为整数，不得改动",
      {
        subjects: [
          { id: "S1", amount: 100n, weights: { A: 2500, B: 2500, C: 2500, D: 2500 } },
          { id: "S2", amount: 40n, weights: { A: 5000, B: 5000 } },
        ],
      },
    ],
    [
      "零权重部门不得分到费用",
      {
        subjects: [
          { id: "S1", amount: 3n, weights: { A: 5000, B: 0, C: 5000 } },
          { id: "S2", amount: 7n, weights: { A: 0, B: 0, C: 10000 } },
        ],
      },
    ],
    [
      "零金额科目与单部门科目",
      {
        subjects: [
          { id: "S1", amount: 0n, weights: { A: 3333, B: 3333, C: 3334 } },
          { id: "S2", amount: 7n, weights: { A: 10000 } },
        ],
      },
    ],
  ];
  for (const [label, batch] of cases) checkCase(batch, label);
});

test("随机小实例（至多4科目×4部门）对照穷举最优解", () => {
  const rng = mulberry32(20261004);
  const randomWeights = (d: number): number[] => {
    const cuts = [0, 10000];
    for (let i = 0; i < d - 1; i++) cuts.push(Math.floor(rng() * 10001));
    cuts.sort((a, b) => a - b);
    const weights: number[] = [];
    for (let i = 0; i < d; i++) weights.push(cuts[i + 1]! - cuts[i]!);
    return weights;
  };
  const departmentPool = ["A", "B", "C", "D"];
  for (let caseIndex = 0; caseIndex < 300; caseIndex++) {
    const subjectCount = 1 + Math.floor(rng() * 4);
    const departmentCount = 1 + Math.floor(rng() * 4);
    const subjects: ExpenseSubject[] = [];
    for (let s = 0; s < subjectCount; s++) {
      const weights: Record<string, number> = {};
      const ws = randomWeights(departmentCount);
      for (let j = 0; j < departmentCount; j++) {
        weights[departmentPool[j]!] = ws[j]!;
      }
      subjects.push({
        id: `S${s}`,
        amount: BigInt(Math.floor(rng() * 31)),
        weights,
      });
    }
    checkCase({ subjects }, `随机用例#${caseIndex}`);
  }
});
