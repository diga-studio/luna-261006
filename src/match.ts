/**
 * 在底稿与新版之间建立保持顺序的一对一相等行匹配。
 * 匹配数最多；平局时从第一对起依次比较，底稿行号小者优先，再相同则新版行号小者优先。
 */
export function matchLines(base: string[], next: string[]): Array<[number, number]> {
  const n = base.length;
  const m = next.length;
  const width = m + 1;
  // dp[i*width + j] = base[i..] 与 next[j..] 的最长匹配长度
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const skipBase = dp[(i + 1) * width + j] as number;
      const skipNext = dp[i * width + j + 1] as number;
      let best = skipBase > skipNext ? skipBase : skipNext;
      if (base[i] === next[j]) {
        const take = (dp[(i + 1) * width + j + 1] as number) + 1;
        if (take > best) best = take;
      }
      dp[i * width + j] = best;
    }
  }
  // 贪心选取：剩余匹配数 k 时，取行号最小的可行匹配对（先底稿后新版）。
  // base[i] === next[j] 且 dp[i][j] === k 蕴含 dp[i+1][j+1] === k-1，
  // 因此该对一定可以作为某个最优匹配方案的下一对。
  const matches: Array<[number, number]> = [];
  let k = dp[0] as number;
  let j0 = 0;
  for (let i = 0; i < n && k > 0; i++) {
    for (let j = j0; j < m; j++) {
      if (base[i] === next[j] && (dp[i * width + j] as number) === k) {
        matches.push([i, j]);
        k--;
        j0 = j + 1;
        break;
      }
    }
  }
  return matches;
}
