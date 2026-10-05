import { feasibleFlow } from "./flow";
import type { BoundedEdge } from "./flow";
import { add, ceilRat, floorRat, ratFromInt, roundHalfUp } from "./rational";
import type { Rat } from "./rational";
import { computeShares } from "./shares";
import type { SettleInput, SettleOutput } from "./types";

function assertNonNegativeInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(what + " 必须是非负整数，得到 " + value);
  }
}

function validate(input: SettleInput): void {
  const ids = new Set<string>();
  for (const work of input.works) {
    if (ids.has(work.id)) throw new Error("成果 ID 重复：" + work.id);
    ids.add(work.id);
    assertNonNegativeInteger(work.budget, "成果 " + work.id + " 的预算");
    const seen = new Set<string>();
    for (const author of work.authors) {
      if (seen.has(author)) {
        throw new Error("成果 " + work.id + " 的作者列表存在重复：" + author);
      }
      seen.add(author);
    }
  }
  for (const cap of input.caps) {
    assertNonNegativeInteger(cap.cap, "作者 " + cap.author + " 在指标 " + cap.indicator + " 的上限");
  }
}

/**
 * 周期结算：返回每项成果分给各署名作者的整数积分。
 *
 * 精确份额 x 见 computeShares。整数分配 z 通过带下界的可行流求出，同时满足：
 * - 每个（成果, 作者）单元格：z 为 x 向下或向上取整；
 * - 每项成果：z 之和为全部 x 之和向下或向上取整；
 * - 每个（作者, 指标）组合：z 之和为全部 x 之和向下或向上取整（不超过 C 由封顶保证）；
 * - 每个指标：z 之和等于全部 x 之和四舍五入（半单位向上）。
 */
export function settle(input: SettleInput): SettleOutput {
  validate(input);
  const cells = computeShares(input);
  const works = input.works;

  // 组合与指标的集合与编号。
  const comboKeys: string[] = [];
  const comboIndex = new Map<string, number>();
  const indicatorKeys: string[] = [];
  const indicatorIndex = new Map<string, number>();
  const cellComboKey: string[] = [];
  for (const cell of cells) {
    const key = JSON.stringify([cell.author, works[cell.workIndex]!.indicator]);
    cellComboKey.push(key);
    if (!comboIndex.has(key)) {
      comboIndex.set(key, comboKeys.length);
      comboKeys.push(key);
    }
  }
  for (const work of works) {
    if (!indicatorIndex.has(work.indicator)) {
      indicatorIndex.set(work.indicator, indicatorKeys.length);
      indicatorKeys.push(work.indicator);
    }
  }

  // 节点编号：0 = 源 S，1 = 汇 T，之后依次是成果、组合、指标。
  const workNode = (i: number) => 2 + i;
  const comboNode = (key: string) => 2 + works.length + comboIndex.get(key)!;
  const indicatorNode = (indicator: string) =>
    2 + works.length + comboKeys.length + indicatorIndex.get(indicator)!;
  const nodeCount = 2 + works.length + comboKeys.length + indicatorKeys.length;

  // 汇总各层面的精确和。
  const workSum: Rat[] = works.map(() => ratFromInt(0n));
  const comboSum = new Map<string, Rat>();
  const indicatorSum = new Map<string, Rat>();
  cells.forEach((cell, i) => {
    const work = works[cell.workIndex]!;
    const key = cellComboKey[i]!;
    workSum[cell.workIndex] = add(workSum[cell.workIndex]!, cell.x);
    comboSum.set(key, add(comboSum.get(key) ?? ratFromInt(0n), cell.x));
    indicatorSum.set(
      work.indicator,
      add(indicatorSum.get(work.indicator) ?? ratFromInt(0n), cell.x),
    );
  });

  const edges: BoundedEdge[] = [];
  // 成果层面：S → 成果。
  works.forEach((_, i) => {
    edges.push({
      from: 0,
      to: workNode(i),
      lo: floorRat(workSum[i]!),
      hi: ceilRat(workSum[i]!),
    });
  });
  // 单元格层面：成果 → （作者, 指标）组合。记录每条边对应的单元格。
  const cellEdgeIndex: number[] = [];
  cells.forEach((cell, i) => {
    cellEdgeIndex.push(edges.length);
    edges.push({
      from: workNode(cell.workIndex),
      to: comboNode(cellComboKey[i]!),
      lo: floorRat(cell.x),
      hi: ceilRat(cell.x),
    });
  });
  // 组合层面：（作者, 指标）→ 指标。
  for (const key of comboKeys) {
    const parsed = JSON.parse(key) as [string, string];
    const sum = comboSum.get(key)!;
    edges.push({
      from: comboNode(key),
      to: indicatorNode(parsed[1]),
      lo: floorRat(sum),
      hi: ceilRat(sum),
    });
  }
  // 指标层面：指标 → T，固定为四舍五入（半单位向上）后的值。
  let totalOut = 0n;
  for (const indicator of indicatorKeys) {
    const rounded = roundHalfUp(indicatorSum.get(indicator) ?? ratFromInt(0n));
    totalOut += rounded;
    edges.push({
      from: indicatorNode(indicator),
      to: 1,
      lo: rounded,
      hi: rounded,
    });
  }
  // 汇回源的循环边，使全网成为可行循环流问题。
  edges.push({ from: 1, to: 0, lo: totalOut, hi: totalOut });

  const flows = feasibleFlow(nodeCount, edges);
  if (flows === null) {
    throw new Error("结算约束不可满足：不存在同时符合三层汇总约束的整数分配");
  }

  const result: SettleOutput = works.map((work) => ({
    workId: work.id,
    shares: {},
  }));
  cells.forEach((cell, i) => {
    const z = flows[cellEdgeIndex[i]!]!;
    result[cell.workIndex]!.shares[cell.author] = Number(z);
  });
  return result;
}
