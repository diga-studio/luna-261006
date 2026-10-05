import type { IndicatorFlags, RuleSet, Tier } from "./types.js";

/** 基准规则：六个指标的命中权重与中/高边界 */
export const BASELINE_RULES: RuleSet = {
  weights: [25, 20, 15, 10, 15, 10],
  midThreshold: 40,
  highThreshold: 70,
};

function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** 校验一套规则是否合法；不合法时抛出 Error */
export function validateRules(rules: RuleSet): void {
  if (!Array.isArray(rules.weights) || rules.weights.length !== 6) {
    throw new Error("rules.weights must contain exactly 6 entries");
  }
  for (const w of rules.weights) {
    if (!isIntegerInRange(w, 0, 100)) {
      throw new Error(`weight must be an integer in [0, 100], got ${w}`);
    }
  }
  if (!Number.isInteger(rules.midThreshold) || rules.midThreshold < 0) {
    throw new Error(`midThreshold must be a non-negative integer, got ${rules.midThreshold}`);
  }
  if (!Number.isInteger(rules.highThreshold) || rules.highThreshold > 100) {
    throw new Error(`highThreshold must be an integer <= 100, got ${rules.highThreshold}`);
  }
  if (rules.midThreshold >= rules.highThreshold) {
    throw new Error(
      `midThreshold (${rules.midThreshold}) must be strictly less than highThreshold (${rules.highThreshold})`,
    );
  }
}

/** 按命中指标求和，总分封顶 100 */
export function scoreOf(flags: IndicatorFlags, rules: RuleSet): number {
  const w = rules.weights;
  let sum = 0;
  if (flags.gpaBelow2) sum += w[0];
  if (flags.attendanceBelow75) sum += w[1];
  if (flags.aidIncomplete) sum += w[2];
  if (flags.undeclaredOver30) sum += w[3];
  if (flags.withdrew2Plus) sum += w[4];
  if (flags.firstGen) sum += w[5];
  return Math.min(sum, 100);
}

/** 分数等于边界时进入较高档位 */
export function tierOf(score: number, rules: RuleSet): Tier {
  if (score >= rules.highThreshold) return "high";
  if (score >= rules.midThreshold) return "medium";
  return "low";
}
