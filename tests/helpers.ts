import { INDICATOR_KEYS } from '../src/types';
import type {
  CandidateRule,
  IndicatorKey,
  ParamKey,
  RuleSet,
  StudentInput,
  Tier,
} from '../src/types';

/** Deterministic PRNG (mulberry32) so tests are reproducible. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomIndicators(rng: () => number): Record<IndicatorKey, boolean> {
  const indicators = {} as Record<IndicatorKey, boolean>;
  for (const key of INDICATOR_KEYS) indicators[key] = rng() < 0.5;
  return indicators;
}

export function randomStudents(
  count: number,
  rng: () => number,
  idPrefix = 'S',
): StudentInput[] {
  const students: StudentInput[] = [];
  for (let i = 0; i < count; i++) {
    students.push({ id: `${idPrefix}${i}`, indicators: randomIndicators(rng) });
  }
  return students;
}

/** Random valid candidate: each of the 8 params changed with probability p. */
export function randomCandidate(
  rng: () => number,
  base: RuleSet,
  changeProbability = 0.6,
): CandidateRule {
  const candidate: CandidateRule = {};
  const weights: Partial<Record<IndicatorKey, number>> = {};
  for (const key of INDICATOR_KEYS) {
    if (rng() < changeProbability) weights[key] = Math.floor(rng() * 101);
  }
  if (Object.keys(weights).length > 0) candidate.weights = weights;
  let mid = base.midThreshold;
  let high = base.highThreshold;
  if (rng() < changeProbability) mid = Math.floor(rng() * 101);
  if (rng() < changeProbability) high = Math.floor(rng() * 101);
  if (mid >= high) {
    // keep the candidate legal
    mid = base.midThreshold;
    high = base.highThreshold;
  }
  candidate.midThreshold = mid;
  candidate.highThreshold = high;
  return candidate;
}

export function resolveForTest(base: RuleSet, candidate: CandidateRule): RuleSet {
  return {
    weights: { ...base.weights, ...(candidate.weights ?? {}) },
    midThreshold: candidate.midThreshold ?? base.midThreshold,
    highThreshold: candidate.highThreshold ?? base.highThreshold,
  };
}

export function scoreOf(indicators: Record<IndicatorKey, boolean>, rule: RuleSet): number {
  let sum = 0;
  for (const key of INDICATOR_KEYS) {
    if (indicators[key]) sum += rule.weights[key];
  }
  return Math.min(100, sum);
}

export function tierOf(score: number, rule: RuleSet): Tier {
  if (score >= rule.highThreshold) return 'high';
  if (score >= rule.midThreshold) return 'mid';
  return 'low';
}

const PARAM_LIST: { key: ParamKey; read: (r: RuleSet) => number }[] = [
  ...INDICATOR_KEYS.map((key) => ({
    key: `weight:${key}` as ParamKey,
    read: (r: RuleSet) => r.weights[key],
  })),
  { key: 'threshold:mid', read: (r: RuleSet) => r.midThreshold },
  { key: 'threshold:high', read: (r: RuleSet) => r.highThreshold },
];

function applyParams(base: RuleSet, candidate: RuleSet, params: ParamKey[]): RuleSet {
  const merged: RuleSet = {
    weights: { ...base.weights },
    midThreshold: base.midThreshold,
    highThreshold: base.highThreshold,
  };
  for (const param of params) {
    if (param === 'threshold:mid') merged.midThreshold = candidate.midThreshold;
    else if (param === 'threshold:high') merged.highThreshold = candidate.highThreshold;
    else {
      const indicator = param.slice('weight:'.length) as IndicatorKey;
      merged.weights[indicator] = candidate.weights[indicator];
    }
  }
  return merged;
}

function isLegal(rule: RuleSet): boolean {
  return rule.midThreshold < rule.highThreshold;
}

/**
 * Reference implementation written directly from the spec: enumerate every
 * subset of the changed parameters, keep the legal sufficient ones, then drop
 * any that has a legal sufficient proper subset.
 */
export function naiveExplanations(
  indicators: Record<IndicatorKey, boolean>,
  base: RuleSet,
  candidate: RuleSet,
): ParamKey[][] {
  const candidateTier = tierOf(scoreOf(indicators, candidate), candidate);
  const changed = PARAM_LIST.filter(
    ({ read }) => read(base) !== read(candidate),
  ).map(({ key }) => key);

  const sufficient: ParamKey[][] = [];
  for (let mask = 1; mask < 1 << changed.length; mask++) {
    const params = changed.filter((_, i) => mask & (1 << i));
    const merged = applyParams(base, candidate, params);
    if (!isLegal(merged)) continue;
    if (tierOf(scoreOf(indicators, merged), merged) === candidateTier) {
      sufficient.push(params);
    }
  }
  const keyOf = (params: ParamKey[]) => [...params].sort().join('|');
  const sufficientKeys = new Set(sufficient.map(keyOf));
  return sufficient
    .filter((params) => {
      for (let mask = 1; mask < 1 << params.length; mask++) {
        const subset = params.filter((_, i) => mask & (1 << i));
        if (subset.length === params.length) continue;
        if (sufficientKeys.has(keyOf(subset))) return false;
      }
      return true;
    })
    .map((params) => [...params].sort())
    .sort((a, b) => a.length - b.length || a.join('|').localeCompare(b.join('|')));
}

export function normalizeExplanations(explanations: ParamKey[][]): string[] {
  return explanations
    .map((params) => [...params].sort().join('|'))
    .sort((a, b) => a.localeCompare(b));
}
