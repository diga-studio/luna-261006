import { PARAMETER_KEYS, type Explanation, type IndicatorFlags, type ParameterKey, type RuleSet, type Tier } from "./types.js";
import { tierOf } from "./rules.js";

/** 参数 -> 权重下标（0-5），6/7 表示两条边界 */
const PARAM_SLOT: Record<ParameterKey, number> = {
  gpaWeight: 0,
  attendanceWeight: 1,
  aidWeight: 2,
  undeclaredWeight: 3,
  withdrawalWeight: 4,
  firstGenWeight: 5,
  midThreshold: 6,
  highThreshold: 7,
};

function weightSum(flags: IndicatorFlags, weights: readonly number[]): number {
  let sum = 0;
  if (flags.gpaBelow2) sum += weights[0];
  if (flags.attendanceBelow75) sum += weights[1];
  if (flags.aidIncomplete) sum += weights[2];
  if (flags.undeclaredOver30) sum += weights[3];
  if (flags.withdrew2Plus) sum += weights[4];
  if (flags.firstGen) sum += weights[5];
  return sum;
}

function popcount(x: number): number {
  let c = 0;
  while (x !== 0) {
    x &= x - 1;
    c += 1;
  }
  return c;
}

/**
 * 计算一名学生从基准规则到候选规则的全部换档解释。
 *
 * 一份解释是实际发生变化参数的一个子集：只把子集内参数改为候选值、
 * 其余保留基准值后，学生必须到达候选档位；混合后的边界必须合法；
 * 且不存在同样充分的合法真子集。不换档时返回空数组。
 */
export function explainStudent(
  flags: IndicatorFlags,
  baseline: RuleSet,
  candidate: RuleSet,
  candidateTier: Tier,
): Explanation[] {
  const baselineTier = tierOf(Math.min(weightSum(flags, baseline.weights), 100), baseline);
  if (baselineTier === candidateTier) return [];

  // 实际发生变化的参数
  const changed: ParameterKey[] = PARAMETER_KEYS.filter((key) => {
    const slot = PARAM_SLOT[key];
    return slot < 6
      ? baseline.weights[slot] !== candidate.weights[slot]
      : slot === 6
        ? baseline.midThreshold !== candidate.midThreshold
        : baseline.highThreshold !== candidate.highThreshold;
  });
  const n = changed.length;
  if (n === 0) return [];

  const baseUncapped = weightSum(flags, baseline.weights);

  const hits = [
    flags.gpaBelow2,
    flags.attendanceBelow75,
    flags.aidIncomplete,
    flags.undeclaredOver30,
    flags.withdrew2Plus,
    flags.firstGen,
  ];

  // 每个变化参数对未封顶总分的增量；指标未命中时权重变化不影响分数，边界参数为 0
  const deltas: number[] = changed.map((key) => {
    const slot = PARAM_SLOT[key];
    return slot < 6 && hits[slot] ? candidate.weights[slot] - baseline.weights[slot] : 0;
  });

  // 按 popcount 递增枚举非空子集，保证先评估子集再评估超集
  const masks: number[] = [];
  for (let m = 1; m < 1 << n; m += 1) masks.push(m);
  masks.sort((a, b) => popcount(a) - popcount(b));

  // deltaSum[mask]：子集内权重增量之和（DP）
  const deltaSum = new Int32Array(1 << n);
  for (let m = 1; m < 1 << n; m += 1) {
    const low = m & -m;
    const bit = 31 - Math.clz32(low);
    deltaSum[m] = deltaSum[m ^ low] + deltas[bit];
  }

  const foundMasks: number[] = [];
  const explanations: Explanation[] = [];

  for (const mask of masks) {
    // 已包含某份解释 -> 非极小，跳过
    let dominated = false;
    for (const e of foundMasks) {
      if ((e & mask) === e) {
        dominated = true;
        break;
      }
    }
    if (dominated) continue;

    // 混合规则：子集内取候选值，其余取基准值
    let mid = baseline.midThreshold;
    let high = baseline.highThreshold;
    for (let i = 0; i < n; i += 1) {
      if ((mask & (1 << i)) === 0) continue;
      const slot = PARAM_SLOT[changed[i]];
      if (slot === 6) mid = candidate.midThreshold;
      else if (slot === 7) high = candidate.highThreshold;
    }
    if (mid >= high) continue; // 边界不合法，不能作为解释

    const score = Math.min(baseUncapped + deltaSum[mask], 100);
    const tier = score >= high ? "high" : score >= mid ? "medium" : "low";
    if (tier !== candidateTier) continue;

    foundMasks.push(mask);
    explanations.push({
      parameters: changed.filter((_, i) => (mask & (1 << i)) !== 0),
    });
  }

  return explanations;
}
