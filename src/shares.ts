import { div, gt, mul, rat, ratFromInt, add } from "./rational";
import type { Rat } from "./rational";
import type { SettleInput } from "./types";

/** 一个（成果, 作者）单元格的精确有理数份额 x。 */
export interface CellShare {
  workIndex: number;
  author: string;
  x: Rat;
}

function comboKey(author: string, indicator: string): string {
  return JSON.stringify([author, indicator]);
}

/**
 * 计算封顶缩放后每个（成果, 作者）单元格的精确份额 x。
 *
 * 1. 未封顶份额：第 i 位作者（i 从 1 开始）权重为 n-i+1，份额 = P*w/Σw。
 * 2. 对每个（作者, 指标）组合：若份额之和 S 超过上限 C，
 *    该组合所有份额同时乘以 C/S；被扣掉的积分不转给其他作者。
 */
export function computeShares(input: SettleInput): CellShare[] {
  const caps = new Map<string, Rat>();
  for (const c of input.caps) {
    caps.set(comboKey(c.author, c.indicator), ratFromInt(BigInt(c.cap)));
  }

  interface UncappedCell {
    workIndex: number;
    author: string;
    key: string;
    u: Rat;
  }
  const cells: UncappedCell[] = [];
  const comboSums = new Map<string, Rat>();

  input.works.forEach((work, workIndex) => {
    const n = work.authors.length;
    const weightSum = (n * (n + 1)) / 2;
    work.authors.forEach((author, idx) => {
      const weight = n - idx;
      const u = rat(
        BigInt(work.budget) * BigInt(weight),
        BigInt(weightSum),
      );
      const key = comboKey(author, work.indicator);
      cells.push({ workIndex, author, key, u });
      comboSums.set(key, add(comboSums.get(key) ?? ratFromInt(0n), u));
    });
  });

  return cells.map((cell) => {
    const s = comboSums.get(cell.key)!;
    const cap = caps.get(cell.key);
    const x = cap !== undefined && gt(s, cap) ? mul(cell.u, div(cap, s)) : cell.u;
    return { workIndex: cell.workIndex, author: cell.author, x };
  });
}
