import { minCostFlow, type McfEdge } from "./minCostFlow.js";
import type { AllocationResult, Batch } from "./types.js";

export type { AllocationResult, Batch, Subject } from "./types.js";

const BASIS = 10000n;

/**
 * 对一批共享费用做分摊：
 * - 单格取理想金额的 floor/ceil；
 * - 每个科目合计恰好等于科目金额；
 * - 每个部门合计取该部门理想合计的 floor/ceil；
 * - 先最小化部门合计绝对误差之和，再最小化单格绝对误差之和。
 *
 * 建模：y_ij ∈ {0,1} 表示单格是否向上取整。行和为等式、列和为区间约束，
 * 两级目标均为线性函数。网络采用“下界循环流”的标准变换：
 * 列 j 到汇点的免费边容量恰为 k_j（该部门必有的向上取整次数），
 * 全部入汇边容量之和等于总流量，因此最小费用最大流必然饱和所有免费边，
 * 下界自动成立。约束矩阵全幺模，必存在整数最优解。
 */
export function allocate(batch: Batch): AllocationResult {
  const subjects = batch.subjects;

  const deptIds: string[] = [];
  const deptIndex = new Map<string, number>();
  for (const s of subjects) {
    for (const deptId of Object.keys(s.weights)) {
      if (!deptIndex.has(deptId)) {
        deptIndex.set(deptId, deptIds.length);
        deptIds.push(deptId);
      }
    }
  }
  const n = subjects.length;
  const m = deptIds.length;

  // floors[i][j]、rems[i][j]：理想金额 amount*weight/10000 的整数部分与万分余数。
  const floors: bigint[][] = [];
  const rems: number[][] = [];
  const rowUp: number[] = []; // r_i = 该科目需要向上取整的格子数
  for (const s of subjects) {
    const fRow = new Array<bigint>(m).fill(0n);
    const rRow = new Array<number>(m).fill(0);
    let floorSum = 0n;
    for (const [deptId, w] of Object.entries(s.weights)) {
      const j = deptIndex.get(deptId)!;
      const num = s.amount * BigInt(w);
      fRow[j] = num / BASIS;
      rRow[j] = Number(num % BASIS);
      floorSum += fRow[j];
    }
    floors.push(fRow);
    rems.push(rRow);
    rowUp.push(Number(s.amount - floorSum));
  }

  // 列：colRemSum[j] = 该部门全部余数之和；k_j 为必有的向上取整次数，frac_j 为列理想合计的万分余数。
  const colK = new Array<number>(m).fill(0);
  const colFrac = new Array<number>(m).fill(0);
  for (let j = 0; j < m; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rems[i][j];
    colK[j] = Math.floor(sum / 10000);
    colFrac[j] = sum % 10000;
  }

  // 最小费用流。费用全部放大 10000 倍保持整数；
  // 一级目标（部门误差）再乘 BIG，保证字典序优先于二级目标（单格误差）。
  const BIG = Math.max(1, n * m) * 10000 + 1;

  const source = 0;
  const rowNode = (i: number) => 1 + i;
  const colNode = (j: number) => 1 + n + j;
  const pass = 1 + n + m; // 额外向上取整的汇聚点，经容量 E 的边入汇，控制全表额外进位总数
  const sink = pass + 1;

  const edges: McfEdge[] = [];
  const cellEdge: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(-1));
  let requiredFlow = 0;
  for (let i = 0; i < n; i++) {
    edges.push({ from: source, to: rowNode(i), capacity: rowUp[i], cost: 0 });
    requiredFlow += rowUp[i];
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (rems[i][j] === 0) continue; // 理想金额为整数（或权重为 0），不得改动
      cellEdge[i][j] = edges.length;
      edges.push({
        from: rowNode(i),
        to: colNode(j),
        capacity: 1,
        cost: 10000 - 2 * rems[i][j], // 二级目标：该格向上取整的误差增量
      });
    }
  }
  let sumK = 0;
  for (let j = 0; j < m; j++) {
    sumK += colK[j];
    if (colK[j] > 0) {
      edges.push({ from: colNode(j), to: sink, capacity: colK[j], cost: 0 });
    }
    if (colFrac[j] > 0) {
      // 一级目标：该部门合计再向上取整 1 分的误差增量
      edges.push({ from: colNode(j), to: pass, capacity: 1, cost: BIG * (10000 - 2 * colFrac[j]) });
    }
  }
  const extra = requiredFlow - sumK; // 全表额外进位（列合计向上）的总次数
  edges.push({ from: pass, to: sink, capacity: extra, cost: 0 });

  const { flows } = minCostFlow(sink + 1, edges, source, sink, requiredFlow);

  const matrix: Record<string, Record<string, bigint>> = {};
  const departmentTotals: Record<string, bigint> = {};
  for (const deptId of deptIds) departmentTotals[deptId] = 0n;
  for (let i = 0; i < n; i++) {
    const row: Record<string, bigint> = {};
    for (let j = 0; j < m; j++) {
      const up = cellEdge[i][j] >= 0 ? flows[cellEdge[i][j]] : 0;
      const value = floors[i][j] + BigInt(up);
      row[deptIds[j]] = value;
      departmentTotals[deptIds[j]] += value;
    }
    matrix[subjects[i].id] = row;
  }

  return { matrix, departmentTotals };
}
