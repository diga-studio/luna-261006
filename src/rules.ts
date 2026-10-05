import { INDICATOR_KEYS } from './types';
import type { CandidateRule, IndicatorKey, RuleSet, Tier } from './types';

/** The default base rule from the business spec. */
export const DEFAULT_BASE_RULE: RuleSet = {
  weights: {
    gpaBelow2: 25,
    attendanceBelow75: 20,
    aidIncomplete: 15,
    undeclaredOver30Credits: 10,
    withdrew2Plus: 15,
    firstGeneration: 10,
  },
  midThreshold: 40,
  highThreshold: 70,
};

/**
 * Internal, array-based rule form used by the hot path.
 * weights follow INDICATOR_KEYS order.
 */
export interface CompiledRule {
  weights: number[];
  mid: number;
  high: number;
}

export function compileRule(rule: RuleSet): CompiledRule {
  return {
    weights: INDICATOR_KEYS.map((key) => rule.weights[key]),
    mid: rule.midThreshold,
    high: rule.highThreshold,
  };
}

function assertIntegerInRange(value: number, min: number, max: number, name: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${String(value)}`);
  }
}

export function validateRuleSet(rule: RuleSet): void {
  for (const key of INDICATOR_KEYS) {
    assertIntegerInRange(rule.weights[key], 0, 100, `weights.${key}`);
  }
  assertIntegerInRange(rule.midThreshold, 0, 100, 'midThreshold');
  assertIntegerInRange(rule.highThreshold, 0, 100, 'highThreshold');
  if (rule.midThreshold >= rule.highThreshold) {
    throw new RangeError(
      `midThreshold (${rule.midThreshold}) must be strictly less than highThreshold (${rule.highThreshold})`,
    );
  }
}

/** Resolve a candidate (partial) against the base rule, validating the result. */
export function resolveCandidate(base: RuleSet, candidate: CandidateRule): RuleSet {
  if (candidate === null || typeof candidate !== 'object') {
    throw new TypeError('candidate must be an object');
  }
  const weights: Record<IndicatorKey, number> = { ...base.weights };
  if (candidate.weights !== undefined) {
    if (candidate.weights === null || typeof candidate.weights !== 'object') {
      throw new TypeError('candidate.weights must be an object');
    }
    for (const [key, value] of Object.entries(candidate.weights)) {
      if (!(INDICATOR_KEYS as readonly string[]).includes(key)) {
        throw new TypeError(`unknown indicator key: ${key}`);
      }
      weights[key as IndicatorKey] = value as number;
    }
  }
  const resolved: RuleSet = {
    weights,
    midThreshold: candidate.midThreshold ?? base.midThreshold,
    highThreshold: candidate.highThreshold ?? base.highThreshold,
  };
  validateRuleSet(resolved);
  return resolved;
}

/** Score for a 6-bit indicator mask, capped at 100. */
export function scoreForMask(mask: number, rule: CompiledRule): number {
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    if (mask & (1 << i)) sum += rule.weights[i]!;
  }
  return sum > 100 ? 100 : sum;
}

/** Tier for a score; a score exactly on a boundary goes to the higher tier. */
export function tierForScore(score: number, mid: number, high: number): Tier {
  if (score >= high) return 'high';
  if (score >= mid) return 'mid';
  return 'low';
}

export function maskFromIndicators(indicators: Record<IndicatorKey, boolean>): number {
  let mask = 0;
  for (let i = 0; i < INDICATOR_KEYS.length; i++) {
    if (indicators[INDICATOR_KEYS[i]!]) mask |= 1 << i;
  }
  return mask;
}
