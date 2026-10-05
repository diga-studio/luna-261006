import assert from "node:assert/strict";
import test from "node:test";
import { BASELINE_RULES, scoreOf, tierOf, validateRules } from "../src/index.js";
import type { IndicatorFlags, RuleSet } from "../src/index.js";

const noHits: IndicatorFlags = {
  gpaBelow2: false,
  attendanceBelow75: false,
  aidIncomplete: false,
  undeclaredOver30: false,
  withdrew2Plus: false,
  firstGen: false,
};

test("基准权重：仅前三项命中得 60 分", () => {
  const score = scoreOf({ ...noHits, gpaBelow2: true, attendanceBelow75: true, aidIncomplete: true }, BASELINE_RULES);
  assert.equal(score, 60);
});

test("未命中指标不计分", () => {
  assert.equal(scoreOf(noHits, BASELINE_RULES), 0);
  assert.equal(scoreOf({ ...noHits, firstGen: true }, BASELINE_RULES), 10);
});

test("总分封顶 100", () => {
  const all = { ...noHits, gpaBelow2: true, attendanceBelow75: true, aidIncomplete: true, undeclaredOver30: true, withdrew2Plus: true, firstGen: true };
  const big: RuleSet = { weights: [100, 100, 100, 100, 100, 100], midThreshold: 40, highThreshold: 70 };
  assert.equal(scoreOf(all, big), 100);
  assert.equal(scoreOf(all, BASELINE_RULES), 95);
});

test("分数等于边界时进入较高档位", () => {
  assert.equal(tierOf(39, BASELINE_RULES), "low");
  assert.equal(tierOf(40, BASELINE_RULES), "medium");
  assert.equal(tierOf(69, BASELINE_RULES), "medium");
  assert.equal(tierOf(70, BASELINE_RULES), "high");
  assert.equal(tierOf(100, BASELINE_RULES), "high");
});

test("规则校验", () => {
  assert.doesNotThrow(() => validateRules(BASELINE_RULES));
  assert.doesNotThrow(() => validateRules({ weights: [0, 0, 0, 0, 0, 0], midThreshold: 0, highThreshold: 100 }));
  assert.throws(() => validateRules({ weights: [-1, 0, 0, 0, 0, 0], midThreshold: 40, highThreshold: 70 }));
  assert.throws(() => validateRules({ weights: [101, 0, 0, 0, 0, 0], midThreshold: 40, highThreshold: 70 }));
  assert.throws(() => validateRules({ weights: [1.5, 0, 0, 0, 0, 0], midThreshold: 40, highThreshold: 70 }));
  assert.throws(() => validateRules({ weights: [0, 0, 0, 0, 0, 0], midThreshold: -1, highThreshold: 70 }));
  assert.throws(() => validateRules({ weights: [0, 0, 0, 0, 0, 0], midThreshold: 70, highThreshold: 70 }));
  assert.throws(() => validateRules({ weights: [0, 0, 0, 0, 0, 0], midThreshold: 80, highThreshold: 70 }));
  assert.throws(() => validateRules({ weights: [0, 0, 0, 0, 0, 0], midThreshold: 40, highThreshold: 101 }));
});
