/**
 * 相似度与编辑距离计算。
 * 长度与编辑单位均为 Unicode 码点；插入、删除、替换代价均为 1；
 * 相邻字符交换不算一次编辑。
 */

/** 将字符串转为码点数组。 */
export function toCodePoints(text: string): Uint32Array {
  const arr = new Uint32Array(text.length);
  let n = 0;
  for (const ch of text) {
    arr[n++] = ch.codePointAt(0)!;
  }
  return arr.subarray(0, n);
}

/**
 * 两个码点序列的 Levenshtein 编辑距离（精确值）。
 * maxDistance 给出时可提前终止：若真实距离超过 maxDistance，
 * 返回值可能为任意大于 maxDistance 的数（调用方只用于阈值判断）。
 */
export function levenshtein(a: Uint32Array, b: Uint32Array, maxDistance?: number): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;

  if (maxDistance !== undefined) {
    if (Math.abs(n - m) > maxDistance) return maxDistance + 1;
    return boundedLevenshtein(a, b, maxDistance);
  }

  // 完整 DP，两行滚动。
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const ai = a[i - 1]!;
    for (let j = 1; j <= m; j++) {
      const cost = ai === b[j - 1]! ? 0 : 1;
      const del = prev[j]! + 1;
      const ins = curr[j - 1]! + 1;
      const sub = prev[j - 1]! + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m]!;
}

/**
 * 带状 DP：只计算 |i-j| <= maxDistance 的对角带，
 * 若真实距离超过 maxDistance 则返回 maxDistance + 1。
 * 行 i 的单元 D(i, j) 存放在下标 (j - i + maxDistance)。
 */
function boundedLevenshtein(a: Uint32Array, b: Uint32Array, maxDistance: number): number {
  const n = a.length;
  const m = b.length;
  const INF = maxDistance + 1;
  const width = 2 * maxDistance + 1;
  let prev = new Uint32Array(width).fill(INF);
  let curr = new Uint32Array(width).fill(INF);
  // 第 0 行：D(0, j) = j，带内范围 j ∈ [0, maxDistance]，下标 j + maxDistance
  for (let j = 0; j <= Math.min(m, maxDistance); j++) prev[j + maxDistance] = j;

  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]!;
    const jLo = Math.max(1, i - maxDistance);
    const jHi = Math.min(m, i + maxDistance);
    const loIdx = jLo - i + maxDistance;
    const hiIdx = jHi - i + maxDistance;
    // 只需显式维护带外两侧的哨兵，带内单元每行都会被覆写
    if (loIdx > 0) curr[loIdx - 1] = INF;
    if (hiIdx + 1 < width) curr[hiIdx + 1] = INF;
    // j = 0 这一列：D(i, 0) = i，仅当 i <= maxDistance 时在带内
    if (i <= maxDistance) curr[maxDistance - i] = i;
    let rowMin = INF;
    for (let j = jLo; j <= jHi; j++) {
      const idx = j - i + maxDistance;
      const cost = ai === b[j - 1]! ? 0 : 1;
      const del = idx + 1 < width ? prev[idx + 1]! + 1 : INF; // D(i-1, j) + 1
      const ins = idx > 0 ? curr[idx - 1]! + 1 : INF; // D(i, j-1) + 1
      const sub = prev[idx]! + cost; // D(i-1, j-1) + cost
      const v = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
      curr[idx] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDistance) return INF;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const result = prev[m - n + maxDistance]!;
  return result > maxDistance ? INF : result;
}

/**
 * 相似度 = 1 - 编辑距离 / max(lenA, lenB)。
 * 两侧均为空串时为 1；仅一侧为空串时为 0。
 */
export function similarity(a: string, b: string): number {
  const pa = toCodePoints(a);
  const pb = toCodePoints(b);
  const maxLen = Math.max(pa.length, pb.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(pa, pb);
  return 1 - dist / maxLen;
}

/** Myers 位并行算法的预处理结果：对固定的 pattern 可反复计算与不同 text 的距离。 */
export interface MyersPattern {
  /** pattern 码点数 m。 */
  readonly length: number;
  /** 32 位字的个数：ceil(m / 32)。 */
  readonly words: number;
  /** 码点 -> 其在 pattern 中位置的位掩码（按 32 位字切分）。 */
  readonly eq: Map<number, Uint32Array>;
  /** 第 (m-1) 位在最后一个字中的掩码。 */
  readonly lastBit: number;
}

/** 预处理 pattern，供 myersDistance 复用（同一查询对多条记录时只建一次）。 */
export function buildMyersPattern(pattern: Uint32Array): MyersPattern {
  const m = pattern.length;
  const words = Math.ceil(m / 32);
  const eq = new Map<number, Uint32Array>();
  for (let i = 0; i < m; i++) {
    const cp = pattern[i]!;
    let mask = eq.get(cp);
    if (mask === undefined) {
      mask = new Uint32Array(words);
      eq.set(cp, mask);
    }
    mask[i >>> 5]! |= 1 << (i & 31);
  }
  const lastBit = 1 << ((m - 1) & 31);
  return { length: m, words, eq, lastBit };
}

/**
 * Myers 位并行编辑距离：O(ceil(m/32) * n)，精确值。
 * pattern 需先经 buildMyersPattern 预处理；pattern 或 text 为空时退化为对方长度。
 */
export function myersDistance(pat: MyersPattern, text: Uint32Array): number {
  const m = pat.length;
  const n = text.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const w = pat.words;
  const Pv = new Uint32Array(w).fill(0xffffffff);
  const Mv = new Uint32Array(w);
  const Xh = new Uint32Array(w);
  const Ph = new Uint32Array(w);
  const Mh = new Uint32Array(w);
  const lastW = w - 1;
  const lastBit = pat.lastBit;
  let score = m;
  for (let t = 0; t < n; t++) {
    const eqMask = pat.eq.get(text[t]!);
    // 第一遍：逐字计算 Xh（加法进位跨字传播）
    let carry = 0;
    for (let i = 0; i < w; i++) {
      const eq = eqMask === undefined ? 0 : eqMask[i]!;
      const pv = Pv[i]!;
      const xv = (eq | Mv[i]!) >>> 0;
      const and = (eq & pv) >>> 0; // 位运算结果可能为负数，先转无符号
      const sum = and + pv + carry; // Number 精确容纳 33 位
      carry = sum > 0xffffffff ? 1 : 0;
      Xh[i] = ((sum >>> 0) ^ pv) | eq;
      // 暂存 Xv 于 Ph，下一步复用
      Ph[i] = xv;
    }
    // 分数更新（在移位前读取最后一个字的第 m-1 位）
    const phLast = (Mv[lastW]! | ~((Xh[lastW]! | Pv[lastW]!) >>> 0)) | 0;
    const mhLast = (Pv[lastW]! & Xh[lastW]!) | 0;
    if ((phLast & lastBit) !== 0) score++;
    else if ((mhLast & lastBit) !== 0) score--;
    // 第二遍：计算 Ph/Mh 并跨字移位，更新 Pv/Mv
    let phCarry = 1; // Ph 左移时最低位补 1
    let mhCarry = 0;
    for (let i = 0; i < w; i++) {
      const xv = Ph[i]!;
      const xh = Xh[i]!;
      const ph = (Mv[i]! | ~((xh | Pv[i]!) >>> 0)) | 0;
      const mh = (Pv[i]! & xh) | 0;
      const phShift = ((ph << 1) | phCarry) | 0;
      const mhShift = ((mh << 1) | mhCarry) | 0;
      phCarry = (ph >>> 31) & 1;
      mhCarry = (mh >>> 31) & 1;
      Pv[i] = (mhShift | ~((xv | phShift) >>> 0)) >>> 0;
      Mv[i] = (phShift & xv) >>> 0;
    }
  }
  return score;
}
