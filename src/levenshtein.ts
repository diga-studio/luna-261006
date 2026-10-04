/**
 * Levenshtein 编辑距离与相似度。
 * 编辑单位为 Unicode 码点；插入、删除、替换代价均为 1；相邻交换不算一次编辑。
 */

/** 按 Unicode 码点拆分字符串（正确处理非 BMP 字符）。 */
export function codePoints(s: string): string[] {
  return Array.from(s);
}

/**
 * 带上限的编辑距离（条带动态规划 + 行提前终止）。
 * 若真实距离 <= maxDist 返回精确距离，否则返回 maxDist + 1。
 */
export function boundedDistanceCP(
  a: readonly string[],
  b: readonly string[],
  maxDist: number,
): number {
  const n = a.length;
  const m = b.length;
  const k = maxDist;
  const INF = k + 1;
  if (n === 0) return m <= k ? m : INF;
  if (m === 0) return n <= k ? n : INF;
  if (Math.abs(n - m) > k) return INF;

  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    let lo = i - k;
    if (lo < 0) lo = 0;
    let hi = i + k;
    if (hi > m) hi = m;
    const ai = a[i - 1]!;
    let left: number;
    if (lo === 0) {
      cur[0] = i;
      left = i;
    } else {
      left = INF;
    }
    let rowMin = INF;
    const jStart = lo === 0 ? 1 : lo;
    for (let j = jStart; j <= hi; j++) {
      // prev[j] 仅在 j === i + k 时超出上一行条带，按 INF 处理
      const up = j === hi && hi === i + k ? INF : prev[j]!;
      const diag = prev[j - 1]!;
      const cost = ai === b[j - 1] ? 0 : 1;
      let v = up + 1;
      if (left + 1 < v) v = left + 1;
      if (diag + cost < v) v = diag + cost;
      cur[j] = v;
      left = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > k) return INF;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const d = prev[m]!;
  return d <= k ? d : INF;
}

/** 完整 Levenshtein 编辑距离（码点为单位）。 */
export function levenshteinDistance(a: string, b: string): number {
  const acp = codePoints(a);
  const bcp = codePoints(b);
  return boundedDistanceCP(acp, bcp, Math.max(acp.length, bcp.length));
}

/**
 * 相似度 = 1 - 编辑距离 / max(码点长度)。
 * 两侧均为空串时为 1，仅一侧为空串时为 0。
 */
export function similarity(a: string, b: string): number {
  const acp = codePoints(a);
  const bcp = codePoints(b);
  const m = Math.max(acp.length, bcp.length);
  if (m === 0) return 1;
  const d = boundedDistanceCP(acp, bcp, m);
  return 1 - d / m;
}
