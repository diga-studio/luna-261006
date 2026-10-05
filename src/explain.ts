import type { CompiledRule } from './rules';
import { tierForScore } from './rules';
import { INDICATOR_KEYS } from './types';
import type { ParamKey, Tier } from './types';

const PARAM_MID = 6;
const PARAM_HIGH = 7;

const PARAM_KEYS: readonly ParamKey[] = [
  ...INDICATOR_KEYS.map((key) => `weight:${key}` as ParamKey),
  'threshold:mid',
  'threshold:high',
];

/**
 * Enumerate every minimal sufficient explanation for one student's indicator
 * mask, given the base rule, the resolved candidate rule and the candidate
 * tier the student lands in.
 *
 * An explanation is a set of actually-changed parameters such that applying
 * only those to the base rule moves this student to the candidate tier, the
 * intermediate rule is legal (mid < high), and no legal proper subset of it
 * is also sufficient.
 */
export function findExplanations(
  mask: number,
  base: CompiledRule,
  candidate: CompiledRule,
  candidateTier: Tier,
): ParamKey[][] {
  // Bitmask (over params 0..7) of parameters that actually changed.
  let changed = 0;
  for (let i = 0; i < 6; i++) {
    if (base.weights[i] !== candidate.weights[i]) changed |= 1 << i;
  }
  if (base.mid !== candidate.mid) changed |= 1 << PARAM_MID;
  if (base.high !== candidate.high) changed |= 1 << PARAM_HIGH;
  if (changed === 0) return [];

  const changedParams: number[] = [];
  for (let p = 0; p < 8; p++) {
    if (changed & (1 << p)) changedParams.push(p);
  }
  const n = changedParams.length;

  // Uncapped base score plus per-weight deltas for this student's mask, so a
  // subset score is a handful of additions.
  let baseUncapped = 0;
  const weightDelta = new Array<number>(6).fill(0);
  for (let i = 0; i < 6; i++) {
    if (mask & (1 << i)) {
      baseUncapped += base.weights[i]!;
      weightDelta[i] = candidate.weights[i]! - base.weights[i]!;
    }
  }

  const subsetCount = 1 << n;
  const sufficient = new Uint8Array(subsetCount);
  for (let sub = 1; sub < subsetCount; sub++) {
    let mid = base.mid;
    let high = base.high;
    let score = baseUncapped;
    for (let j = 0; j < n; j++) {
      if (!(sub & (1 << j))) continue;
      const p = changedParams[j]!;
      if (p === PARAM_MID) mid = candidate.mid;
      else if (p === PARAM_HIGH) high = candidate.high;
      else score += weightDelta[p]!;
    }
    if (mid >= high) continue; // illegal intermediate rule
    if (score > 100) score = 100;
    if (tierForScore(score, mid, high) === candidateTier) {
      sufficient[sub] = 1;
    }
  }

  const result: ParamKey[][] = [];
  for (let sub = 1; sub < subsetCount; sub++) {
    if (!sufficient[sub]) continue;
    // Minimal: no legal proper subset may also be sufficient. (Any sufficient
    // subset recorded above already passed the legality check.)
    let hasSufficientProperSubset = false;
    for (let t = (sub - 1) & sub; t > 0; t = (t - 1) & sub) {
      if (sufficient[t]) {
        hasSufficientProperSubset = true;
        break;
      }
    }
    if (hasSufficientProperSubset) continue;
    const params: ParamKey[] = [];
    for (let j = 0; j < n; j++) {
      if (sub & (1 << j)) params.push(PARAM_KEYS[changedParams[j]!]!);
    }
    result.push(params);
  }
  result.sort((a, b) => a.length - b.length || a.join('|').localeCompare(b.join('|')));
  return result;
}
