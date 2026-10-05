import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileRule,
  DEFAULT_BASE_RULE,
  maskFromIndicators,
  resolveCandidate,
  scoreForMask,
  tierForScore,
  validateRuleSet,
} from '../src/rules';
import type { IndicatorKey } from '../src/types';

const allFalse: Record<IndicatorKey, boolean> = {
  gpaBelow2: false,
  attendanceBelow75: false,
  aidIncomplete: false,
  undeclaredOver30Credits: false,
  withdrew2Plus: false,
  firstGeneration: false,
};

function indicators(partial: Partial<Record<IndicatorKey, boolean>>): Record<IndicatorKey, boolean> {
  return { ...allFalse, ...partial };
}

test('maskFromIndicators maps booleans to bits in fixed order', () => {
  assert.equal(maskFromIndicators(allFalse), 0);
  assert.equal(maskFromIndicators(indicators({ gpaBelow2: true })), 1);
  assert.equal(maskFromIndicators(indicators({ firstGeneration: true })), 32);
  assert.equal(
    maskFromIndicators(indicators({ gpaBelow2: true, aidIncomplete: true })),
    0b00101,
  );
});

test('base scoring: only first three indicators hit gives 60', () => {
  const compiled = compileRule(DEFAULT_BASE_RULE);
  const mask = maskFromIndicators(
    indicators({ gpaBelow2: true, attendanceBelow75: true, aidIncomplete: true }),
  );
  assert.equal(scoreForMask(mask, compiled), 60);
});

test('score is capped at 100', () => {
  const compiled = compileRule({
    weights: {
      gpaBelow2: 100,
      attendanceBelow75: 100,
      aidIncomplete: 15,
      undeclaredOver30Credits: 10,
      withdrew2Plus: 15,
      firstGeneration: 10,
    },
    midThreshold: 40,
    highThreshold: 70,
  });
  const mask = maskFromIndicators(indicators({ gpaBelow2: true, attendanceBelow75: true }));
  assert.equal(scoreForMask(mask, compiled), 100);
});

test('tier boundaries: score exactly on a boundary enters the higher tier', () => {
  assert.equal(tierForScore(39, 40, 70), 'low');
  assert.equal(tierForScore(40, 40, 70), 'mid');
  assert.equal(tierForScore(69, 40, 70), 'mid');
  assert.equal(tierForScore(70, 40, 70), 'high');
  assert.equal(tierForScore(100, 40, 70), 'high');
});

test('validateRuleSet rejects non-integers and out-of-range values', () => {
  const ok = DEFAULT_BASE_RULE;
  assert.doesNotThrow(() => validateRuleSet(ok));
  assert.throws(
    () => validateRuleSet({ ...ok, weights: { ...ok.weights, gpaBelow2: 25.5 } }),
    RangeError,
  );
  assert.throws(
    () => validateRuleSet({ ...ok, weights: { ...ok.weights, gpaBelow2: 101 } }),
    RangeError,
  );
  assert.throws(
    () => validateRuleSet({ ...ok, weights: { ...ok.weights, gpaBelow2: -1 } }),
    RangeError,
  );
  assert.throws(() => validateRuleSet({ ...ok, midThreshold: -1 }), RangeError);
  assert.throws(() => validateRuleSet({ ...ok, highThreshold: 101 }), RangeError);
});

test('validateRuleSet enforces mid < high', () => {
  const ok = DEFAULT_BASE_RULE;
  assert.throws(() => validateRuleSet({ ...ok, midThreshold: 70, highThreshold: 70 }), RangeError);
  assert.throws(() => validateRuleSet({ ...ok, midThreshold: 80, highThreshold: 70 }), RangeError);
});

test('resolveCandidate merges partial overrides and validates the result', () => {
  const resolved = resolveCandidate(DEFAULT_BASE_RULE, {
    weights: { gpaBelow2: 40 },
    midThreshold: 50,
  });
  assert.equal(resolved.weights.gpaBelow2, 40);
  assert.equal(resolved.weights.attendanceBelow75, 20);
  assert.equal(resolved.midThreshold, 50);
  assert.equal(resolved.highThreshold, 70);

  // Only mid moved above the unchanged high boundary: invalid.
  assert.throws(() => resolveCandidate(DEFAULT_BASE_RULE, { midThreshold: 80 }), RangeError);
  assert.throws(
    () => resolveCandidate(DEFAULT_BASE_RULE, { weights: { nope: 1 } as never }),
    TypeError,
  );
});
