import { buildLogFactorials } from "./logFactorial";
import { pearsonChiSquare } from "./statistic";
import type { VariantInput } from "./types";

export interface ExactTestResult {
  chiSquare: number;
  pValue: number;
}

/**
 * 统计量相等判定用的相对容差。
 * 数学上相等的统计量在不同浮点求值路径下可能相差若干 ulp（约 1e-15 相对量级），
 * 业务要求“统计量相等的表必须计入”，因此比较时留出 1e-9 的相对余量。
 */
const STAT_EQUALITY_REL_TOL = 1e-9;
const STAT_EQUALITY_ABS_TOL = 1e-12;

/**
 * 精确检验（Fisher-Freeman-Halton 风格的 r x 2 表）。
 *
 * 固定各版本曝光 n_i 与总互动 M 时，计数表服从多重超几何分布：
 *   P(table) = prod_i C(n_i, x_i) / C(N, M)。
 * p 值 = 所有 统计量 >= 观察统计量 的计数表的概率之和。
 *
 * 实现要点：
 * - 互动/未互动对称：始终枚举总数较小的那一类（业务保证 <= 2000）。
 * - 统计量可分解为逐版本可加项（见 statistic.ts），因此把版本分成两半，
 *   第一半按“互动数 m”分桶、桶内按统计量排序并求权重后缀和；
 *   第二半流式枚举，对每个部分表二分查找第一半中使总统计量达标的权重和。
 *   2+2 拆分下每半最多约 2e6 种组合，满足耗时要求。
 * - 内存：分桶数据使用定长 Float64Array（两遍枚举，先计数后填充），
 *   桶处理完立即释放，峰值内存远低于 256 MiB。
 * - 权重在对数空间计算（组合数对数取自补偿求和的 log 阶乘表），
 *   汇总时使用“最大值缩放”技巧避免下溢，最终绝对误差远小于 1e-10。
 */
export function exactTest(variants: readonly VariantInput[]): ExactTestResult {
  let totalExposure = 0;
  let totalEngaged = 0;
  for (const v of variants) {
    totalExposure += v.exposure;
    totalEngaged += v.engaged;
  }
  const chiSquare = pearsonChiSquare(variants);
  if (totalEngaged === 0 || totalEngaged === totalExposure) {
    // 退化规则：全无互动或全部互动时统计量为 0、p 值为 1。
    return { chiSquare: 0, pValue: 1 };
  }

  const k = variants.length;
  const ns = variants.map((v) => v.exposure);

  // 对称化：枚举总数较小的类别。替换 x_i -> n_i - x_i 后，
  // 组合数 C(n_i, x_i) 不变、统计量各项不变，因此结果完全等价。
  const M = Math.min(totalEngaged, totalExposure - totalEngaged);
  const N = totalExposure;

  const lf = buildLogFactorials(N);
  const p = M / N;
  const denomScale = p * (1 - p);

  // 每个版本的逐取值表：统计量项 t_i(x) 与组合数对数 log C(n_i, x)。
  const statTable: Float64Array[] = [];
  const logWTable: Float64Array[] = [];
  const caps: number[] = [];
  for (let i = 0; i < k; i += 1) {
    const n = ns[i]!;
    const hi = Math.min(n, M);
    caps.push(hi);
    const st = new Float64Array(hi + 1);
    const lw = new Float64Array(hi + 1);
    const expected = n * p;
    const scale = n * denomScale;
    const lfN = lf[n]!;
    for (let x = 0; x <= hi; x += 1) {
      const diff = x - expected;
      st[x] = (diff * diff) / scale;
      lw[x] = lfN - lf[x]! - lf[n - x]!;
    }
    statTable.push(st);
    logWTable.push(lw);
  }

  // 统计量达标阈值：>= 观察统计量（含相等，留浮点容差）。
  const cutoff = chiSquare - (chiSquare * STAT_EQUALITY_REL_TOL + STAT_EQUALITY_ABS_TOL);

  const hA = Math.ceil(k / 2);
  const idxA: number[] = [];
  const idxB: number[] = [];
  for (let i = 0; i < k; i += 1) {
    (i < hA ? idxA : idxB).push(i);
  }
  let capA = 0;
  let capB = 0;
  for (const i of idxA) capA += caps[i]!;
  for (const i of idxB) capB += caps[i]!;

  // 枚举半个版本组的所有取值（带边际可行性剪枝），回调 (互动数, 统计量项, 对数权重)。
  const enumerateHalf = (
    idx: readonly number[],
    otherCap: number,
    visit: (m: number, s: number, logW: number) => void,
  ): void => {
    if (idx.length === 1) {
      const i = idx[0]!;
      const st = statTable[i]!;
      const lw = logWTable[i]!;
      const lo = Math.max(0, M - otherCap);
      for (let x = lo; x <= caps[i]!; x += 1) {
        visit(x, st[x]!, lw[x]!);
      }
      return;
    }
    const i = idx[0]!;
    const j = idx[1]!;
    const stI = statTable[i]!;
    const lwI = logWTable[i]!;
    const stJ = statTable[j]!;
    const lwJ = logWTable[j]!;
    const loI = Math.max(0, M - otherCap - caps[j]!);
    for (let xi = loI; xi <= caps[i]!; xi += 1) {
      const loJ = Math.max(0, M - otherCap - xi);
      const hiJ = Math.min(caps[j]!, M - xi);
      const si = stI[xi]!;
      const wi = lwI[xi]!;
      for (let xj = loJ; xj <= hiJ; xj += 1) {
        visit(xi + xj, si + stJ[xj]!, wi + lwJ[xj]!);
      }
    }
  };

  // 第一半：两遍枚举。第一遍统计每个 m 的条目数，第二遍填入定长类型化数组。
  const counts = new Uint32Array(M + 1);
  enumerateHalf(idxA, capB, (m) => {
    counts[m]! += 1;
  });
  const rawStat: (Float64Array | null)[] = new Array(M + 1).fill(null);
  const rawLogW: (Float64Array | null)[] = new Array(M + 1).fill(null);
  let maxBucketLen = 0;
  for (let m = 0; m <= M; m += 1) {
    const c = counts[m]!;
    if (c > 0) {
      rawStat[m] = new Float64Array(c);
      rawLogW[m] = new Float64Array(c);
      if (c > maxBucketLen) maxBucketLen = c;
    }
  }
  const offsets = new Uint32Array(M + 1);
  enumerateHalf(idxA, capB, (m, s, logW) => {
    const o = offsets[m]!;
    rawStat[m]![o] = s;
    rawLogW[m]![o] = logW;
    offsets[m] = o + 1;
  });

  // 每桶：按统计量排序（复用下标缓冲），权重转线性空间（减去桶内最大值），求后缀和。
  // 处理完的桶立即释放原始数组，控制峰值内存。
  const sortedStat: (Float64Array | null)[] = new Array(M + 1).fill(null);
  const suffixWeight: (Float64Array | null)[] = new Array(M + 1).fill(null);
  const bucketMaxLogW = new Float64Array(M + 1).fill(-Infinity);
  const order: number[] = [];
  for (let m = 0; m <= M; m += 1) {
    const ss = rawStat[m];
    const ww = rawLogW[m];
    if (ss == null || ww == null) continue;
    const len = ss.length;
    let maxLogW = -Infinity;
    for (let t = 0; t < len; t += 1) {
      if (ww[t]! > maxLogW) maxLogW = ww[t]!;
    }
    order.length = len;
    for (let t = 0; t < len; t += 1) order[t] = t;
    order.sort((a, b) => ss[a]! - ss[b]!);
    const st = new Float64Array(len);
    const suf = new Float64Array(len);
    let acc = 0;
    for (let t = len - 1; t >= 0; t -= 1) {
      const idx = order[t]!;
      st[t] = ss[idx]!;
      acc += Math.exp(ww[idx]! - maxLogW);
      suf[t] = acc;
    }
    sortedStat[m] = st;
    suffixWeight[m] = suf;
    bucketMaxLogW[m] = maxLogW;
    rawStat[m] = null;
    rawLogW[m] = null;
  }

  // 第二半：流式枚举，累加 统计量达标 的表的对数权重（最大值缩放）。
  let numMaxLog = -Infinity;
  let numSum = 0;
  enumerateHalf(idxB, capA, (mB, sB, logWB) => {
    const mA = M - mB;
    const st = sortedStat[mA];
    if (st === null || st === undefined) return;
    const threshold = cutoff - sB;
    let lo = 0;
    let hi = st.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (st[mid]! >= threshold) hi = mid;
      else lo = mid + 1;
    }
    if (lo === st.length) return;
    const contrib = logWB + bucketMaxLogW[mA]! + Math.log(suffixWeight[mA]![lo]!);
    if (contrib > numMaxLog) {
      numSum = numSum * Math.exp(numMaxLog - contrib) + 1;
      numMaxLog = contrib;
    } else {
      numSum += Math.exp(contrib - numMaxLog);
    }
  });

  const logDenom = lf[N]! - lf[M]! - lf[N - M]!;
  let pValue = numSum * Math.exp(numMaxLog - logDenom);
  if (!(pValue > 0)) pValue = 0;
  if (pValue > 1) pValue = 1;
  return { chiSquare, pValue };
}
