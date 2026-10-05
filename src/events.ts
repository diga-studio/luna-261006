/**
 * 单个项目对“每日收入差分数组”的贡献事件。
 * 在 revDiff[day] 上累加 delta，前缀和即为该项目对当日收入的贡献。
 */
export interface RevEvent {
  day: number;
  delta: bigint;
}

/**
 * 由项目事实（原金额、服务区间、截至当前的退款表）构建完整收入事件表。
 *
 * 记号：A 原金额，D 服务天数，s 服务起日，lastDay = s + D - 1。
 * C(d) = A - 截至 d 已生效退款；k(d) = clamp(d - s + 1, 0, D)。
 * 应累计确认 F(d)：k=0 为 0；k=D 为 C(d)；其余 floor(C(d)/D)*k。
 * 当日收入 rev(d) = F(d) - F(d-1)。
 *
 * 退款日 t 把 [t, +∞) 的 C 降低 R，由此 rev 序列的变化为：
 * - t 在服务期内（t <= lastDay-1，k = t-s+1 <= D-1）：
 *   当日点调整 (q'-q)*(k-1)，其后每日斜率 q -> q'，末日尾差随之变化；
 * - t == lastDay：末日确认额由 C_old 变为 C_new，相当于当日 -R；
 * - t > lastDay：当日 -R（服务结束后的退款直接冲减收入）。
 * 末日确认额 rev(lastDay) = C(lastDay) - q(prev)*(D-1)，其中 q(prev)
 * 为 lastDay-1 当日所处退款分段的日额（D=1 时该项为 0）。
 *
 * refunds 须按生效日升序且同日已合并，总额不超过 A。返回按 day 升序合并后的事件。
 */
export function buildItemEvents(
  amount: bigint,
  startDay: number,
  days: number,
  refunds: ReadonlyArray<{ day: number; amount: bigint }>,
): RevEvent[] {
  const raw: RevEvent[] = [];
  const push = (day: number, delta: bigint): void => {
    if (delta !== 0n) raw.push({ day, delta });
  };
  const rangeAdd = (lo: number, hi: number, v: bigint): void => {
    if (lo <= hi && v !== 0n) {
      push(lo, v);
      push(hi + 1, -v);
    }
  };

  const lastDay = startDay + days - 1;
  const bigDays = BigInt(days);

  // 分段边界：a_0 = s，其后为各退款生效日；C_j 为该分段适用的净额
  const bounds: number[] = new Array(refunds.length + 1);
  bounds[0] = startDay;
  for (let i = 0; i < refunds.length; i++) bounds[i + 1] = refunds[i].day;

  const netOf: bigint[] = new Array(bounds.length);
  const dailyOf: bigint[] = new Array(bounds.length);
  let cum = 0n;
  for (let j = 0; j < bounds.length; j++) {
    if (j > 0) cum += refunds[j - 1].amount;
    const c = amount - cum;
    netOf[j] = c;
    dailyOf[j] = c / bigDays; // c >= 0，截断即向下取整
  }

  // 1) 服务期内各分段的日额（区间加）
  for (let j = 0; j < bounds.length; j++) {
    const lo = bounds[j];
    const next = j + 1 < bounds.length ? bounds[j + 1] : Number.POSITIVE_INFINITY;
    const hi = Math.min(next - 1, lastDay - 1);
    rangeAdd(lo, hi, dailyOf[j]);
  }

  // 2) 退款日点调整
  for (let j = 1; j < bounds.length; j++) {
    const t = bounds[j];
    if (t < lastDay) {
      const k = t - startDay + 1;
      rangeAdd(t, t, (dailyOf[j] - dailyOf[j - 1]) * BigInt(k - 1));
    } else if (t > lastDay) {
      rangeAdd(t, t, -refunds[j - 1].amount);
    }
    // t == lastDay：由末日公式中的 C(lastDay) 直接体现
  }

  // 3) 服务末日确认额（含尾差与末日当天退款）
  let netLast = netOf[0];
  let dailyPrev = 0n;
  for (let j = 0; j < bounds.length; j++) {
    if (bounds[j] <= lastDay) netLast = netOf[j];
    if (bounds[j] <= lastDay - 1) dailyPrev = dailyOf[j];
  }
  rangeAdd(lastDay, lastDay, netLast - dailyPrev * BigInt(days - 1));

  // 按日合并
  raw.sort((a, b) => a.day - b.day);
  const merged: RevEvent[] = [];
  for (const e of raw) {
    const last = merged[merged.length - 1];
    if (last && last.day === e.day) {
      last.delta += e.delta;
    } else {
      merged.push({ day: e.day, delta: e.delta });
    }
  }
  return merged.filter((e) => e.delta !== 0n);
}
