import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExplanations } from '../src/explain';
import { compileRule, DEFAULT_BASE_RULE, resolveCandidate, scoreForMask } from '../src/rules';
import { maskFromIndicators } from '../src/rules';
import type { CandidateRule, IndicatorKey } from '../src/types';
import {
  makeRng,
  naiveExplanations,
  normalizeExplanations,
  randomCandidate,
  resolveForTest,
} from './helpers';

const BASE = compileRule(DEFAULT_BASE_RULE);

function maskOf(...hit: IndicatorKey[]): number {
  const indicators = Object.fromEntries(
    [
      'gpaBelow2',
      'attendanceBelow75',
      'aidIncomplete',
      'undeclaredOver30Credits',
      'withdrew2Plus',
      'firstGeneration',
    ].map((key) => [key, hit.includes(key as IndicatorKey)]),
  ) as Record<IndicatorKey, boolean>;
  return maskFromIndicators(indicators);
}

function explanationsFor(mask: number, candidate: CandidateRule): string[] {
  const resolved = compileRule(resolveCandidate(DEFAULT_BASE_RULE, candidate));
  const candidateScore = scoreForMask(mask, resolved);
  const candidateTier =
    candidateScore >= resolved.high ? 'high' : candidateScore >= resolved.mid ? 'mid' : 'low';
  return normalizeExplanations(findExplanations(mask, BASE, resolved, candidateTier));
}

test('acceptance: first three indicators, weights 40/25/20 -> exactly two explanations', () => {
  // Base: 25+20+15 = 60 (mid). Candidate: 40+25+20 = 85 (high).
  const mask = maskOf('gpaBelow2', 'attendanceBelow75', 'aidIncomplete');
  const explanations = explanationsFor(mask, {
    weights: { gpaBelow2: 40, attendanceBelow75: 25, aidIncomplete: 20 },
  });
  assert.deepEqual(explanations, [
    'weight:aidIncomplete|weight:attendanceBelow75',
    'weight:gpaBelow2',
  ]);
});

test('acceptance: boundaries 80/90 -> explanation must contain both boundaries', () => {
  // Same student: base 60 (mid). Candidate boundaries make 60 low.
  const mask = maskOf('gpaBelow2', 'attendanceBelow75', 'aidIncomplete');
  const explanations = explanationsFor(mask, { midThreshold: 80, highThreshold: 90 });
  assert.deepEqual(explanations, ['threshold:high|threshold:mid']);
});

test('weights up and down: three singleton explanations, raised weight never sufficient alone', () => {
  // Base: 25+20+15+10 = 70 (high). Candidate: 30+15+5+0 = 50 (mid).
  const mask = maskOf('gpaBelow2', 'attendanceBelow75', 'aidIncomplete', 'firstGeneration');
  const explanations = explanationsFor(mask, {
    weights: { gpaBelow2: 30, attendanceBelow75: 15, aidIncomplete: 5, firstGeneration: 0 },
  });
  assert.deepEqual(explanations, [
    'weight:aidIncomplete',
    'weight:attendanceBelow75',
    'weight:firstGeneration',
  ]);
});

test('100 cap: raised weight saturates the score, explanation still minimal and complete', () => {
  // Base: 25+20+15+15+10 = 85 (high).
  // Candidate: 60+0+0+0+0 = 60 (mid). Reaching mid from 85 means dropping
  // into [40, 70): {attendance} alone (65), or any pair of the smaller
  // decreases not containing attendance; anything larger has a sufficient
  // proper subset, and sets containing the raised GPA weight stay >= 70
  // unless all decreases are applied too -- but that set contains
  // {attendance}, so it is not minimal.
  const mask = maskOf(
    'gpaBelow2',
    'attendanceBelow75',
    'aidIncomplete',
    'withdrew2Plus',
    'firstGeneration',
  );
  const candidate: CandidateRule = {
    weights: {
      gpaBelow2: 60,
      attendanceBelow75: 0,
      aidIncomplete: 0,
      withdrew2Plus: 0,
      firstGeneration: 0,
    },
  };
  const explanations = explanationsFor(mask, candidate);
  assert.deepEqual(explanations, [
    'weight:aidIncomplete|weight:firstGeneration',
    'weight:aidIncomplete|weight:withdrew2Plus',
    'weight:attendanceBelow75',
    'weight:firstGeneration|weight:withdrew2Plus',
  ]);

  // Note: {gpa} alone evaluates as min(100, 85+35) = 100 -> high, so the cap
  // (not the raw sum) is what the tier check sees inside the enumeration.
});

test('score cap at 100 is applied to the reported candidate score', () => {
  const allSix = maskOf(
    'gpaBelow2',
    'attendanceBelow75',
    'aidIncomplete',
    'undeclaredOver30Credits',
    'withdrew2Plus',
    'firstGeneration',
  );
  const resolved = compileRule(
    resolveCandidate(DEFAULT_BASE_RULE, {
      weights: { gpaBelow2: 100, attendanceBelow75: 100 },
    }),
  );
  assert.equal(scoreForMask(allSix, resolved), 100);
});

test('identical candidate produces no explanations', () => {
  const mask = maskOf('gpaBelow2', 'attendanceBelow75', 'aidIncomplete');
  assert.deepEqual(explanationsFor(mask, {}), []);
});

test('cross-check optimized enumeration against naive spec implementation', () => {
  const rng = makeRng(20261006);
  for (let trial = 0; trial < 300; trial++) {
    const candidate = randomCandidate(rng, DEFAULT_BASE_RULE, 0.7);
    const resolved = resolveForTest(DEFAULT_BASE_RULE, candidate);
    const compiled = compileRule(resolved);
    for (let mask = 0; mask < 64; mask++) {
      const candidateScore = scoreForMask(mask, compiled);
      const candidateTier =
        candidateScore >= compiled.high
          ? 'high'
          : candidateScore >= compiled.mid
            ? 'mid'
            : 'low';
      const actual = normalizeExplanations(
        findExplanations(mask, BASE, compiled, candidateTier),
      );
      const indicators = Object.fromEntries(
        [
          'gpaBelow2',
          'attendanceBelow75',
          'aidIncomplete',
          'undeclaredOver30Credits',
          'withdrew2Plus',
          'firstGeneration',
        ].map((key, i) => [key, Boolean(mask & (1 << i))]),
      ) as Record<IndicatorKey, boolean>;
      const expected = normalizeExplanations(naiveExplanations(indicators, DEFAULT_BASE_RULE, resolved));
      assert.deepEqual(
        actual,
        expected,
        `mask=${mask} candidate=${JSON.stringify(candidate)}`,
      );
    }
  }
});
