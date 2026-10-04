import { minCostFlow } from "./minCostFlow.ts";
import type { FlowEdgeInput } from "./minCostFlow.ts";
import type { AllocationBatch, AllocationResult } from "./types.ts";

/** 万分比分母。 */
const BASIS = 10000;

/**
 * 对一批共享费用执行分摊，返回整数分摊矩阵与部门合计。
 *
 * 保证：
 * - 单格实际金额 = 理想金额（科目金额 × 权重 / 10000）向下或向上取整；
 * - 每个科目的实际分摊合计恰好等于科目金额；
 * - 每个部门的实际合计 = 该部门理想金额之和向下或向上取整；
 * - 在满足以上条件的矩阵中，先最小化部门合计绝对误差之和，
 *   再最小化全部单格绝对误差之和（字典序最优）。
 *
 * 求解思路：把“每格是否向上取整”建成最小费用流。每个科目需要
 * 向上取整的格数 = 科目金额 - 各格理想值下取整之和，是确定的；
 * 每个部门收到的“向上取整”总数被约束在其理想合计的下/上取整之间。
 * 费用分三个数量级：部门下取整边强制饱和（负的大费用）、
 * 部门尾差（大系数 BIG）、单格尾差（小费用），从而字典序最优。
 */
export function allocate(batch: AllocationBatch): AllocationResult {
  const subjects = batch.subjects;

  // 部门列表：按首次出现顺序，取全部科目权重键的并集。
  const departmentIds: string[] = [];
  const departmentIndex = new Map<string, number>();
  for (const subject of subjects) {
    for (const departmentId of Object.keys(subject.weights)) {
      if (!departmentIndex.has(departmentId)) {
        departmentIndex.set(departmentId, departmentIds.length);
        departmentIds.push(departmentId);
      }
    }
  }
  const subjectCount = subjects.length;
  const departmentCount = departmentIds.length;

  // 每格理想值 = amount * weight / 10000 = floor + rem/10000。
  // floorMatrix[s][d] 为下取整部分，remMatrix[s][d] 为余数（0..9999）。
  const floorMatrix: bigint[][] = [];
  const remMatrix: number[][] = [];
  // 每个科目需要“向上取整”的格数（行约束），以及每列余数合计（列约束用）。
  const rowRoundUps: number[] = [];
  const columnRemSums: number[] = new Array<number>(departmentCount).fill(0);

  for (const subject of subjects) {
    const floors: bigint[] = new Array<bigint>(departmentCount).fill(0n);
    const rems: number[] = new Array<number>(departmentCount).fill(0);
    let floorSum = 0n;
    for (let d = 0; d < departmentCount; d++) {
      const weight = subject.weights[departmentIds[d]!] ?? 0;
      const numerator = subject.amount * BigInt(weight);
      const floor = numerator / BigInt(BASIS);
      const rem = Number(numerator % BigInt(BASIS));
      floors[d] = floor;
      rems[d] = rem;
      floorSum += floor;
      columnRemSums[d] = columnRemSums[d]! + rem;
    }
    floorMatrix.push(floors);
    remMatrix.push(rems);
    // 行余数合计必为整数（权重合计 10000），即本科目需要向上取整的格数。
    rowRoundUps.push(Number(subject.amount - floorSum));
  }

  const totalFlow = rowRoundUps.reduce((sum, r) => sum + r, 0);

  // 费用量级设计（所有“每万分之一的误差”都已放大 10000 倍成整数）：
  // - 单格边费用 20000 - 2*rem ∈ [2, 19998]；
  // - 部门进位边费用 BIG * (20000 - 2*colRem)，BIG 大于任何单格费用总和，
  //   保证先最小化部门合计误差，再最小化单格误差；
  // - 部门下取整边费用 -M，M 大于其余所有费用之和，强制这些边饱和，
  //   即强制每个部门合计达到其理想合计的下取整（列约束的下界）。
  const BIG = BigInt(totalFlow) * 20000n + 1n;
  const maxOtherCost =
    BigInt(totalFlow) * 19998n + BigInt(totalFlow) * BIG * 19998n;
  const M = maxOtherCost + 1n;

  // 节点编号：0 = 源，1 = 汇，2..2+S-1 = 科目，之后为部门。
  const SOURCE = 0;
  const SINK = 1;
  const subjectNode = (s: number): number => 2 + s;
  const departmentNode = (d: number): number => 2 + subjectCount + d;
  const nodeCount = 2 + subjectCount + departmentCount;

  const edges: FlowEdgeInput[] = [];
  // 记录每个 (s, d) 格对应的边下标（仅 rem > 0 的格有边）。
  const cellEdgeIndex: number[][] = [];

  for (let s = 0; s < subjectCount; s++) {
    edges.push({
      from: SOURCE,
      to: subjectNode(s),
      capacity: rowRoundUps[s]!,
      cost: 0n,
    });
  }
  for (let s = 0; s < subjectCount; s++) {
    const row: number[] = new Array<number>(departmentCount).fill(-1);
    for (let d = 0; d < departmentCount; d++) {
      const rem = remMatrix[s]![d]!;
      if (rem === 0) continue; // 理想值为整数（含权重 0），不得改动。
      row[d] = edges.length;
      edges.push({
        from: subjectNode(s),
        to: departmentNode(d),
        capacity: 1,
        cost: BigInt(2 * BASIS - 2 * rem),
      });
    }
    cellEdgeIndex.push(row);
  }
  for (let d = 0; d < departmentCount; d++) {
    const columnRemSum = columnRemSums[d]!;
    const low = Math.floor(columnRemSum / BASIS);
    const columnRem = columnRemSum % BASIS;
    // 下取整部分：必须全部收到（负费用强制饱和）。
    edges.push({
      from: departmentNode(d),
      to: SINK,
      capacity: low,
      cost: -M,
    });
    // 进位部分：至多 1 单位，费用对应部门合计误差的增量。
    if (columnRem > 0) {
      edges.push({
        from: departmentNode(d),
        to: SINK,
        capacity: 1,
        cost: BIG * BigInt(2 * BASIS - 2 * columnRem),
      });
    }
  }

  const flows = minCostFlow(nodeCount, edges, SOURCE, SINK, totalFlow);

  // 由流量还原分摊矩阵与部门合计。
  const matrix: Record<string, Record<string, bigint>> = {};
  const totals: bigint[] = new Array<bigint>(departmentCount).fill(0n);
  for (let s = 0; s < subjectCount; s++) {
    const rowResult: Record<string, bigint> = {};
    for (let d = 0; d < departmentCount; d++) {
      const edgeIndex = cellEdgeIndex[s]![d]!;
      const roundUp = edgeIndex >= 0 ? flows[edgeIndex]! : 0;
      const value = floorMatrix[s]![d]! + BigInt(roundUp);
      rowResult[departmentIds[d]!] = value;
      totals[d] = totals[d]! + value;
    }
    matrix[subjects[s]!.id] = rowResult;
  }
  const departmentTotals: Record<string, bigint> = {};
  for (let d = 0; d < departmentCount; d++) {
    departmentTotals[departmentIds[d]!] = totals[d]!;
  }
  return { matrix, departmentTotals };
}
