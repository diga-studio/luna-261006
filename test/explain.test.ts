import assert from "node:assert/strict";
import test from "node:test";
import {
  BASELINE_RULES,
  PARAMETER_KEYS,
  explainStudent,
  scoreOf,
  tierOf,
  validateRules,
  type Explanation,
  type IndicatorFlags,
  type ParameterKey,
  type RuleSet,
} from "../src/index.js";

const noHits: IndicatorFlags = {
  gpaBelow2: false,
  attendanceBelow75: false,
  aidIncomplete: false,
  undeclaredOver30: false,
  withdrew2Plus: false,
  firstGen: false,
};

const firstThree: IndicatorFlags = { ...noHits, gpaBelow2: true, attendanceBelow75: true, aidIncomplete: true };

function keysOf(explanations: Explanation[]): string[] {
  return explanations.map((e) => [...e.parameters].sort().join("+")).sort();
}

/** 独立蛮力实现：枚举所有子集，按定义判定合法、充分、极小 */
function bruteForce(flags: IndicatorFlags, baseline: RuleSet, candidate: RuleSet): string[] {
  const baselineTier = tierOf(scoreOf(flags, baseline), baseline);
  const candidateTier = tierOf(scoreOf(flags, candidate), candidate);
  if (baselineTier === candidateTier) return [];

  const changed = PARAMETER_KEYS.filter((key) => {
    if (key === "midThreshold") return baseline.midThreshold !== candidate.midThreshold;
    if (key === "highThreshold") return baseline.highThreshold !== candidate.highThreshold;
    const idx = ["gpaWeight", "attendanceWeight", "aidWeight", "undeclaredWeight", "withdrawalWeight", "firstGenWeight"].indexOf(key);
    return baseline.weights[idx] !== candidate.weights[idx];
  });

  const apply = (subset: ParameterKey[]): RuleSet => {
    const weights: number[] = [...baseline.weights];
    let mid = baseline.midThreshold;
    let high = baseline.highThreshold;
    const idxOf: Record<string, number> = { gpaWeight: 0, attendanceWeight: 1, aidWeight: 2, undeclaredWeight: 3, withdrawalWeight: 4, firstGenWeight: 5 };
    for (const key of subset) {
      if (key === "midThreshold") mid = candidate.midThreshold;
      else if (key === "highThreshold") high = candidate.highThreshold;
      else weights[idxOf[key]] = candidate.weights[idxOf[key]];
    }
    return { weights: weights as unknown as RuleSet["weights"], midThreshold: mid, highThreshold: high };
  };

  const sufficient = (subset: ParameterKey[]): boolean => {
    const mixed = apply(subset);
    if (mixed.midThreshold >= mixed.highThreshold) return false;
    return tierOf(scoreOf(flags, mixed), mixed) === candidateTier;
  };

  const result: string[] = [];
  const n = changed.length;
  for (let mask = 1; mask < 1 << n; mask += 1) {
    const subset = changed.filter((_, i) => (mask & (1 << i)) !== 0);
    if (!sufficient(subset)) continue;
    let minimal = true;
    for (let sub = (mask - 1) & mask; sub > 0; sub = (sub - 1) & mask) {
      if (sufficient(changed.filter((_, i) => (sub & (1 << i)) !== 0))) {
        minimal = false;
        break;
      }
    }
    if (minimal) result.push([...subset].sort().join("+"));
  }
  return result.sort();
}

test("验收用例1：仅改 GPA 权重 或 同时改出勤及助学金权重", () => {
  assert.equal(scoreOf(firstThree, BASELINE_RULES), 60);
  const candidate: RuleSet = { weights: [40, 25, 20, 10, 15, 10], midThreshold: 40, highThreshold: 70 };
  const explanations = explainStudent(firstThree, BASELINE_RULES, candidate, "high");
  assert.deepEqual(keysOf(explanations), ["aidWeight+attendanceWeight", "gpaWeight"]);
});

test("验收用例2：边界改为 80/90 时解释必须同时包含两条边界", () => {
  const candidate: RuleSet = { weights: [25, 20, 15, 10, 15, 10], midThreshold: 80, highThreshold: 90 };
  assert.equal(tierOf(scoreOf(firstThree, candidate), candidate), "low");
  const explanations = explainStudent(firstThree, BASELINE_RULES, candidate, "low");
  assert.deepEqual(keysOf(explanations), ["highThreshold+midThreshold"]);
});

test("权重有升有降 + 100 分封顶的组合", () => {
  // 命中前五项：基准 85 分（高档）
  const flags: IndicatorFlags = { ...noHits, gpaBelow2: true, attendanceBelow75: true, aidIncomplete: true, undeclaredOver30: true, withdrew2Plus: true };
  assert.equal(scoreOf(flags, BASELINE_RULES), 85);
  // GPA 权重升到 60，其余四项降到 0：候选 60 分（中档）
  const candidate: RuleSet = { weights: [60, 0, 0, 0, 0, 10], midThreshold: 40, highThreshold: 70 };
  assert.equal(scoreOf(flags, candidate), 60);
  const explanations = explainStudent(flags, BASELINE_RULES, candidate, "medium");
  // 封顶使含 gpaWeight 的集合停在 100 分（高档），无法成为解释
  assert.deepEqual(keysOf(explanations), [
    "aidWeight+undeclaredWeight",
    "aidWeight+withdrawalWeight",
    "attendanceWeight",
    "undeclaredWeight+withdrawalWeight",
  ]);
});

test("不换档的学生不产生解释", () => {
  const candidate: RuleSet = { weights: [40, 25, 20, 10, 15, 10], midThreshold: 40, highThreshold: 70 };
  // 该学生候选下仍为高档（85 分）
  const flags: IndicatorFlags = { ...noHits, gpaBelow2: true, attendanceBelow75: true, aidIncomplete: true, undeclaredOver30: true, withdrew2Plus: true };
  assert.deepEqual(explainStudent(flags, BASELINE_RULES, candidate, "high"), []);
  // 无参数变化时也没有解释
  assert.deepEqual(explainStudent(firstThree, BASELINE_RULES, BASELINE_RULES, "medium"), []);
});

test("随机用例与蛮力实现逐一比对", () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

  for (let iter = 0; iter < 300; iter += 1) {
    const flags: IndicatorFlags = {
      gpaBelow2: rand() < 0.5,
      attendanceBelow75: rand() < 0.5,
      aidIncomplete: rand() < 0.5,
      undeclaredOver30: rand() < 0.5,
      withdrew2Plus: rand() < 0.5,
      firstGen: rand() < 0.5,
    };
    let candidate: RuleSet;
    do {
      const mid = randInt(0, 99);
      candidate = {
        weights: [randInt(0, 100), randInt(0, 100), randInt(0, 100), randInt(0, 100), randInt(0, 100), randInt(0, 100)],
        midThreshold: mid,
        highThreshold: randInt(mid + 1, 100),
      };
    } while (rand() < 0.3); // 多数情况下保留随机规则，偶尔重掷增加边界贴近的用例
    validateRules(candidate);
    const candidateTier = tierOf(scoreOf(flags, candidate), candidate);
    const actual = keysOf(explainStudent(flags, BASELINE_RULES, candidate, candidateTier));
    assert.deepEqual(actual, bruteForce(flags, BASELINE_RULES, candidate), `iter=${iter} flags=${JSON.stringify(flags)} candidate=${JSON.stringify(candidate)}`);
  }
});
