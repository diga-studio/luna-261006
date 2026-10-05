/**
 * 精确 p 值引擎（Fisher-Freeman-Halton 风格的网络算法）。
 *
 * 固定各版本曝光 n_i 与总互动 K，计数表 (x_1..x_m) 的概率为
 *   prod C(n_i, x_i) / C(N, K)。
 * p 值 = 所有满足 chi2(table) >= chi2(observed) 的表的概率之和。
 *
 * 数值方案：
 * - 单个组合数 C(n_i, x) 可能远超 float64 范围（如 C(12000, 2000) ~ 1e2350），
 *   因此全程使用 log 权重 lg_i[x] = log C(n_i, x)（递推计算），
 *   并按桶（B 组互动数 kB / A 组互动数 kA）分别归一化后再取 exp，
 *   所有 exp 结果的因子均 <= 1，不会上溢；尾部长远小于 1e-745 的表
 *   权重下溢为 0，对 p 值的影响远低于 1e-10 的精度要求。
 * - 版本分成两组 A/B。对 B 组按 kB 建立按统计量排序的权重后缀和表；
 *   对 A 组枚举每张表，用二分查找累加满足阈值的 B 组权重。
 * - p = acc / Z，二者用同一套归一化权重，比值即真实概率。
 *
 * 边界（统计量相等必须计入）：浮点比较带 1e-9 相对容差窗口，窗口内的表
 * 用 BigInt 精确比较 sum_i (x_i*N - n_i*K)^2 / n_i 与观察值的大小。
 */

const TIE_REL_TOL = 1e-9;

export function exactPValue(
  exposures: number[],
  converted: number[],
  observedChiSquare: number,
): number {
  const m = exposures.length;
  let totalExposure = 0;
  let totalConverted = 0;
  for (let i = 0; i < m; i++) {
    totalExposure += exposures[i];
    totalConverted += converted[i];
  }
  const N = totalExposure;
  const K = totalConverted;

  // 每个版本的取值上限、贡献数组 c_i[x]、log 权重数组 lg_i[x] = log C(n_i, x)。
  const maxX = new Array<number>(m);
  const contrib: Float64Array[] = new Array(m);
  const logWeight: Float64Array[] = new Array(m);
  const classDenom = K * (N - K);
  for (let i = 0; i < m; i++) {
    const n = exposures[i];
    const cap = Math.min(n, K);
    maxX[i] = cap;
    const c = new Float64Array(cap + 1);
    const denom = n * classDenom;
    for (let x = 0; x <= cap; x++) {
      const d = x * N - n * K;
      c[x] = (d * d) / denom;
    }
    contrib[i] = c;
    const lg = new Float64Array(cap + 1);
    for (let x = 1; x <= cap; x++) {
      lg[x] = lg[x - 1] + Math.log((n - x + 1) / x);
    }
    logWeight[i] = lg;
  }

  // 精确边界判定：比较 S = sum_i d_i^2 / n_i（与卡方统计量只差正常数因子）。
  // 乘以 P = prod n_i 后全部为整数，用 BigInt 精确比较。
  const bigN = exposures.map((n) => BigInt(n));
  let prod = 1n;
  for (const b of bigN) prod *= b;
  const scale = bigN.map((b) => prod / b);
  const observedS = bigintS(exposures, converted, N, K, scale);

  function bigintS(
    ns: number[],
    xs: number[],
    total: number,
    totalSuccess: number,
    scales: bigint[],
  ): bigint {
    let s = 0n;
    for (let i = 0; i < ns.length; i++) {
      const d = BigInt(xs[i] * total - ns[i] * totalSuccess);
      s += d * d * scales[i];
    }
    return s;
  }

  // 分组：A 组为前 ceil(m/2) 个版本，B 组为其余。
  const aCount = Math.ceil(m / 2);
  const aIdx = Array.from({ length: aCount }, (_, i) => i);
  const bIdx = Array.from({ length: m - aCount }, (_, i) => aCount + i);

  // ---- 构建 B 组结构：按 kB 分桶，桶内按统计量升序，存归一化权重后缀和 ----
  const offsets = new Int32Array(K + 2);
  for (let k = 0; k <= K; k++) {
    offsets[k + 1] = offsets[k] + bBucketSize(k);
  }
  const totalB = offsets[K + 1];
  const sB = new Float64Array(totalB);
  const suffixW = new Float64Array(totalB);
  const xFirst = new Int32Array(totalB);
  // 每桶 log 权重的最大值（用于归一化），空桶为 -Infinity。
  const maxLogB = new Float64Array(K + 1).fill(-Infinity);

  function bBucketSize(k: number): number {
    if (bIdx.length === 1) {
      return k <= maxX[bIdx[0]] ? 1 : 0;
    }
    const lo = Math.max(0, k - maxX[bIdx[1]]);
    const hi = Math.min(maxX[bIdx[0]], k);
    return hi >= lo ? hi - lo + 1 : 0;
  }

  for (let k = 0; k <= K; k++) {
    const start = offsets[k];
    const size = offsets[k + 1] - start;
    if (size === 0) continue;
    const ss = new Array<number>(size);
    const lw = new Array<number>(size);
    const xx = new Array<number>(size);
    if (bIdx.length === 1) {
      const u = bIdx[0];
      ss[0] = contrib[u][k];
      lw[0] = logWeight[u][k];
      xx[0] = k;
    } else {
      const u = bIdx[0];
      const v = bIdx[1];
      const lo = Math.max(0, k - maxX[v]);
      const hi = Math.min(maxX[u], k);
      let j = 0;
      for (let x = lo; x <= hi; x++) {
        ss[j] = contrib[u][x] + contrib[v][k - x];
        lw[j] = logWeight[u][x] + logWeight[v][k - x];
        xx[j] = x;
        j++;
      }
    }
    let maxLw = -Infinity;
    for (let j = 0; j < size; j++) {
      if (lw[j] > maxLw) maxLw = lw[j];
    }
    maxLogB[k] = maxLw;
    const order = Array.from({ length: size }, (_, i) => i).sort(
      (a, b) => ss[a] - ss[b],
    );
    let acc = 0;
    for (let j = size - 1; j >= 0; j--) {
      const src = order[j];
      acc += Math.exp(lw[src] - maxLw);
      const dst = start + j;
      sB[dst] = ss[src];
      suffixW[dst] = acc;
      xFirst[dst] = xx[src];
    }
  }

  // zB[k]：B 组互动数为 k 的全部表的归一化权重和（空桶为 0）。
  const zB = new Float64Array(K + 1);
  for (let k = 0; k <= K; k++) {
    zB[k] = offsets[k + 1] > offsets[k] ? suffixW[offsets[k]] : 0;
  }

  // ---- A 组枚举 ----
  const window = TIE_REL_TOL * Math.max(1, observedChiSquare);

  // 枚举 A 组所有表，回调 (kA, sA, logW, aXs)。logW 为未归一化的 log 权重。
  function enumerateA(
    callback: (kA: number, sA: number, logW: number, aXs: number[]) => void,
  ): void {
    if (aIdx.length === 1) {
      const u = aIdx[0];
      const cu = contrib[u];
      const lu = logWeight[u];
      for (let x = 0; x <= maxX[u]; x++) {
        callback(x, cu[x], lu[x], [x]);
      }
      return;
    }
    const u = aIdx[0];
    const v = aIdx[1];
    const cu = contrib[u];
    const cv = contrib[v];
    const lu = logWeight[u];
    const lv = logWeight[v];
    for (let xu = 0; xu <= maxX[u]; xu++) {
      const cx = cu[xu];
      const lx = lu[xu];
      const maxV = Math.min(maxX[v], K - xu);
      for (let xv = 0; xv <= maxV; xv++) {
        callback(xu + xv, cx + cv[xv], lx + lv[xv], [xu, xv]);
      }
    }
  }

  // 第 0 遍：A 组每个 kA 的 log 权重最大值（用于归一化）。
  const maxLogA = new Float64Array(K + 1).fill(-Infinity);
  enumerateA((kA, _sA, lw) => {
    if (lw > maxLogA[kA]) maxLogA[kA] = lw;
  });

  // 第 1 遍：zA[kA] = 该 kA 下 A 组表的归一化权重和。
  const zA = new Float64Array(K + 1);
  enumerateA((kA, _sA, lw) => {
    zA[kA] += Math.exp(lw - maxLogA[kA]);
  });

  // 全局归一化基准：M = max_k (maxLogA[k] + maxLogB[K-k])。
  let maxTotal = -Infinity;
  for (let k = 0; k <= K; k++) {
    const t = maxLogA[k] + maxLogB[K - k];
    if (t > maxTotal) maxTotal = t;
  }
  // Z = 全部合法表的权重和（同一归一化基准）。
  let zTotal = 0;
  for (let k = 0; k <= K; k++) {
    zTotal += Math.exp(maxLogA[k] + maxLogB[K - k] - maxTotal) * zA[k] * zB[K - k];
  }

  // 查询 B 组：在互动数为 kB 的桶内，sA + sB >= T 的归一化权重和。
  function suffixBeyond(kB: number, sA: number, aXs: number[]): number {
    const start = offsets[kB];
    const end = offsets[kB + 1];
    if (start === end) return 0;
    const theta = observedChiSquare - sA;
    // lo：第一个 sB >= theta - window；hi：第一个 sB > theta + window。
    let lo = start;
    {
      let l = start;
      let r = end;
      while (l < r) {
        const mid = (l + r) >> 1;
        if (sB[mid] >= theta - window) r = mid;
        else l = mid + 1;
      }
      lo = l;
    }
    let hi = lo;
    {
      let l = lo;
      let r = end;
      while (l < r) {
        const mid = (l + r) >> 1;
        if (sB[mid] > theta + window) r = mid;
        else l = mid + 1;
      }
      hi = l;
    }
    let sum = hi === end ? 0 : suffixW[hi];
    // 窗口内的表逐条精确判定。
    const xs = new Array<number>(m);
    for (let i = 0; i < aIdx.length; i++) xs[aIdx[i]] = aXs[i];
    for (let j = lo; j < hi; j++) {
      const xu = xFirst[j];
      xs[bIdx[0]] = xu;
      if (bIdx.length === 2) xs[bIdx[1]] = kB - xu;
      if (bigintS(exposures, xs, N, K, scale) >= observedS) {
        const w = suffixW[j] - (j + 1 === end ? 0 : suffixW[j + 1]);
        sum += w;
      }
    }
    return sum;
  }

  // 第 2 遍：累加满足条件的权重。
  let acc = 0;
  enumerateA((kA, sA, lw, aXs) => {
    const kB = K - kA;
    if (kB < 0 || maxLogB[kB] === -Infinity) return;
    const factor = Math.exp(lw + maxLogB[kB] - maxTotal);
    if (factor === 0) return;
    acc += factor * suffixBeyond(kB, sA, aXs);
  });

  return acc / zTotal;
}
