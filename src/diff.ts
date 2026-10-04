import type { Edit, LineMatch } from './types';

/**
 * 计算底稿与新版之间保持顺序的一对一相等行匹配。
 * 匹配行数最多；平局时从第一对匹配起依次比较，
 * 优先底稿行号更早者，再优先新版行号更早者。
 */
export function matchLines(base: string[], side: string[]): LineMatch[] {
  const n = base.length;
  const m = side.length;
  // dp[i][j] = base[i..] 与 side[j..] 的最大匹配数。
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      if (base[i] === side[j]) {
        row[j] = Math.max(next[j]!, row[j + 1]!, next[j + 1]! + 1);
      } else {
        row[j] = Math.max(next[j]!, row[j + 1]!);
      }
    }
  }
  // 贪心回溯：逐个底稿行尝试作为下一对匹配。
  // 若底稿行 i 能出现在某个最优匹配中（存在 j' 使 dp[i][j] = 1 + dp[i+1][j'+1]），
  // 则取最小的这样的 j'，同时满足底稿行号最早、新版行号最早。
  const matches: LineMatch[] = [];
  let j = 0;
  for (let i = 0; i < n && j < m; i++) {
    const remaining = dp[i]![j]!;
    if (remaining === 0) break;
    for (let jj = j; jj < m; jj++) {
      if (base[i] === side[jj] && dp[i + 1]![jj + 1]! === remaining - 1) {
        matches.push({ baseIndex: i, sideIndex: jj });
        j = jj + 1;
        break;
      }
    }
  }
  return matches;
}

/**
 * 由匹配结果提取连续替换序列（含纯插入、纯删除）。
 * 首个匹配之前、末个匹配之后同样视为替换；无匹配时整篇为一次替换。
 */
export function computeEdits(
  base: string[],
  side: string[],
  matches: LineMatch[],
): Edit[] {
  const edits: Edit[] = [];
  let basePos = 0;
  let sidePos = 0;
  const flush = (baseEnd: number, sideEnd: number): void => {
    if (basePos < baseEnd || sidePos < sideEnd) {
      edits.push({
        baseStart: basePos,
        baseEnd,
        lines: side.slice(sidePos, sideEnd),
      });
    }
  };
  for (const match of matches) {
    flush(match.baseIndex, match.sideIndex);
    basePos = match.baseIndex + 1;
    sidePos = match.sideIndex + 1;
  }
  flush(base.length, side.length);
  return edits;
}
