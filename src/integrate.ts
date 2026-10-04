/**
 * 双线性函数正部的精确积分。
 *
 * 矩形 [0,hx]×[0,hy] 上的双线性函数由四角值唯一确定：
 *   f(x,y) = a + b*x + c*y + d*x*y
 * 当 d != 0 时可化为 f = d*(x-xc)*(y-yc) + k（双曲线中心 (xc,yc)），
 * 正部积分归结为单一核心函数 P(a,b,c,d,t) = ∫∫ (u*v + t)+ dv du
 * （第一象限矩形 [a,b]×[c,d]），它有闭式解（含对数项）。
 * 当 d == 0（或鞍点项可忽略）时 f 为线性函数，用半平面裁剪 + 三角形扇精确积分。
 */

/**
 * P(a,b,c,d,t) = ∫_a^b ∫_c^d (u*v + t)+ dv du，其中 0<=a<=b，0<=c<=d。
 */
function positiveQuadrantIntegral(
  a: number,
  b: number,
  c: number,
  d: number,
  t: number,
): number {
  const w = b - a;
  const h = d - c;
  if (w <= 0 || h <= 0) return 0;
  const area = w * h;
  const meanUV = ((b * b - a * a) * (d * d - c * c)) / 4; // ∫∫ u*v
  if (t >= 0) {
    // u*v + t 恒非负
    return meanUV + t * area;
  }
  const tau = -t; // > 0，零点曲线 u*v = tau
  // 对固定 u：v* = tau/u。v* <= c 时整段为正；v* >= d 时整段为零；否则部分为正。
  // 注意 c 可能为 -0，直接 tau/c 会得到 -Infinity，必须显式判零。
  const uFull = c === 0 ? Infinity : tau / c;
  const uZero = tau / d; // d > 0 已保证
  let sum = 0;
  // 整段为正区间 [max(a,uFull), b]：原函数 u^2(d^2-c^2)/4 - tau*(d-c)*u
  const lo1 = Math.max(a, uFull);
  if (lo1 < b) {
    sum +=
      ((b * b - lo1 * lo1) * (d * d - c * c)) / 4 -
      tau * (d - c) * (b - lo1);
  }
  // 部分为正区间 [max(a,uZero), min(b,uFull)]：原函数 u^2 d^2/4 - tau*d*u + (tau^2/2)*ln u
  const lo2 = Math.max(a, uZero);
  const hi2 = Math.min(b, uFull);
  if (lo2 < hi2) {
    sum +=
      ((hi2 * hi2 - lo2 * lo2) * d * d) / 4 -
      tau * d * (hi2 - lo2) +
      (tau * tau * 0.5) * Math.log(hi2 / lo2);
  }
  return sum;
}

/** 线性函数 f(x,y) = a + b*x + c*y 在矩形 [0,hx]×[0,hy] 上正部的精确积分。 */
function integratePositivePartLinear(
  hx: number,
  hy: number,
  a: number,
  b: number,
  c: number,
): number {
  // 矩形顶点（逆时针）及其函数值
  let xs = [0, hx, hx, 0];
  let ys = [0, 0, hy, hy];
  let fs = xs.map((x, i) => a + b * x + c * ys[i]);
  // Sutherland–Hodgman：保留 f >= 0 的半平面
  const nxs: number[] = [];
  const nys: number[] = [];
  const nfs: number[] = [];
  const n = xs.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const fi = fs[i];
    const fj = fs[j];
    const inI = fi >= 0;
    const inJ = fj >= 0;
    if (inI) {
      nxs.push(xs[i]);
      nys.push(ys[i]);
      nfs.push(fi);
    }
    if (inI !== inJ) {
      // 边上 f 线性变化，交点处 f = 0
      const s = fi / (fi - fj);
      nxs.push(xs[i] + s * (xs[j] - xs[i]));
      nys.push(ys[i] + s * (ys[j] - ys[i]));
      nfs.push(0);
    }
  }
  xs = nxs;
  ys = nys;
  fs = nfs;
  if (xs.length < 3) return 0;
  // 三角形扇：线性函数在三角形上的积分 = 面积 * 顶点值平均
  let sum = 0;
  for (let i = 1; i + 1 < xs.length; i++) {
    const x1 = xs[i] - xs[0];
    const y1 = ys[i] - ys[0];
    const x2 = xs[i + 1] - xs[0];
    const y2 = ys[i + 1] - ys[0];
    const triArea = Math.abs(x1 * y2 - x2 * y1) / 2;
    sum += (triArea * (fs[0] + fs[i] + fs[i + 1])) / 3;
  }
  return sum;
}

/** 鞍点项相对量小于该阈值时按线性处理（引入误差不超过 阈值*函数尺度*面积）。 */
const LINEAR_EPS = 1e-12;

/**
 * 在矩形 [0,hx]×[0,hy] 上，对以四角值定义的双线性函数 f 的正部 (f)+ 做精确积分。
 * 角值顺序：f00=f(0,0), f10=f(hx,0), f01=f(0,hy), f11=f(hx,hy)。
 */
export function integratePositivePartBilinear(
  hx: number,
  hy: number,
  f00: number,
  f10: number,
  f01: number,
  f11: number,
): number {
  if (hx <= 0 || hy <= 0) return 0;
  const b = (f10 - f00) / hx;
  const c = (f01 - f00) / hy;
  const saddle = f00 - f10 - f01 + f11; // = d*hx*hy
  const d = saddle / (hx * hy);
  const scale = Math.max(Math.abs(f00), Math.abs(f10), Math.abs(f01), Math.abs(f11));
  if (d === 0 || Math.abs(saddle) <= LINEAR_EPS * (scale + 1e-300)) {
    return integratePositivePartLinear(hx, hy, f00, b, c);
  }
  // 化为 f = d*(x-xc)*(y-yc) + k
  const xc = -c / d;
  const yc = -b / d;
  const k = f00 + b * xc + c * yc + d * xc * yc; // = a - b*c/d
  const absD = Math.abs(d);
  const t = k / absD;
  // u = x - xc ∈ [u0,u1]，v = y - yc ∈ [v0,v1]，按象限拆成至多 4 个子矩形
  const u0 = -xc;
  const u1 = hx - xc;
  const v0 = -yc;
  const v1 = hy - yc;
  // 中心可能落在矩形之外，各段必须与 [u0,u1]（或 [v0,v1]）求交
  const uSegs: Array<[number, number, number]> = [
    [u0, Math.min(u1, 0), -1],
    [Math.max(u0, 0), u1, 1],
  ];
  const vSegs: Array<[number, number, number]> = [
    [v0, Math.min(v1, 0), -1],
    [Math.max(v0, 0), v1, 1],
  ];
  let sum = 0;
  for (const [ua, ub, su] of uSegs) {
    if (ub <= ua) continue;
    // 换到第一象限：û = |u| ∈ [uaP, ubP]
    const uaP = su < 0 ? -ub : ua;
    const ubP = su < 0 ? -ua : ub;
    for (const [va, vb, sv] of vSegs) {
      if (vb <= va) continue;
      const vaP = sv < 0 ? -vb : va;
      const vbP = sv < 0 ? -va : vb;
      // 被积函数 (d*u*v + k)+ = |d| * (s*û*ṽ + t)+，s = sign(d*su*sv)
      const s = d * su * sv > 0 ? 1 : -1;
      if (s > 0) {
        sum += positiveQuadrantIntegral(uaP, ubP, vaP, vbP, t);
      } else {
        // (-ûṽ + t)+ = (ûṽ - t)+ + (t - ûṽ)，后两项直接积分
        const area = (ubP - uaP) * (vbP - vaP);
        const meanUV =
          ((ubP * ubP - uaP * uaP) * (vbP * vbP - vaP * vaP)) / 4;
        sum +=
          positiveQuadrantIntegral(uaP, ubP, vaP, vbP, -t) + t * area - meanUV;
      }
    }
  }
  return absD * sum;
}
