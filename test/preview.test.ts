import assert from "node:assert/strict";
import test from "node:test";
import {
  BASELINE_RULES,
  RulePreviewEngine,
  TIERS,
  scoreOf,
  tierOf,
  type IndicatorFlags,
  type PreviewResult,
  type RuleSet,
  type StudentSnapshot,
  type Tier,
  type TransitionKey,
} from "../src/index.js";

function makeStudents(count: number, seed = 7): StudentSnapshot[] {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const students: StudentSnapshot[] = [];
  for (let i = 0; i < count; i += 1) {
    students.push({
      studentId: `S${i}`,
      gpaBelow2: rand() < 0.3,
      attendanceBelow75: rand() < 0.3,
      aidIncomplete: rand() < 0.3,
      undeclaredOver30: rand() < 0.3,
      withdrew2Plus: rand() < 0.3,
      firstGen: rand() < 0.3,
    });
  }
  return students;
}

function flagsOf(s: StudentSnapshot): IndicatorFlags {
  return {
    gpaBelow2: s.gpaBelow2,
    attendanceBelow75: s.attendanceBelow75,
    aidIncomplete: s.aidIncomplete,
    undeclaredOver30: s.undeclaredOver30,
    withdrew2Plus: s.withdrew2Plus,
    firstGen: s.firstGen,
  };
}

/** 逐学生重算的参照实现 */
function recomputePerStudent(students: StudentSnapshot[], candidate: RuleSet): PreviewResult {
  const transitions = Object.fromEntries(
    TIERS.map((from) => [from, Object.fromEntries(TIERS.map((to) => [to, 0]))]),
  ) as Record<Tier, Record<Tier, number>>;
  const explanations: Partial<Record<TransitionKey, Map<string, number>>> = {};
  const engine = new RulePreviewEngine(students);
  for (const s of students) {
    const flags = flagsOf(s);
    const from = tierOf(scoreOf(flags, BASELINE_RULES), BASELINE_RULES);
    const to = tierOf(scoreOf(flags, candidate), candidate);
    transitions[from][to] += 1;
    if (from === to) continue;
    const key: TransitionKey = `${from}->${to}`;
    const bucket = (explanations[key] ??= new Map());
    for (const e of engine.previewStudent(candidate, s.studentId).explanations) {
      const label = [...e.parameters].sort().join(",");
      bucket.set(label, (bucket.get(label) ?? 0) + 1);
    }
  }
  const flat: PreviewResult["explanations"] = {};
  for (const [key, bucket] of Object.entries(explanations) as [TransitionKey, Map<string, number>][]) {
    flat[key] = [...bucket.entries()].map(([label, count]) => ({
      parameters: label.split(",") as never,
      count,
    }));
  }
  return { transitions, explanations: flat };
}

function normalize(result: PreviewResult) {
  const explanations: Record<string, Record<string, number>> = {};
  for (const [key, list] of Object.entries(result.explanations)) {
    explanations[key] = Object.fromEntries(
      (list ?? []).map((e) => [[...e.parameters].sort().join(","), e.count]),
    );
  }
  return { transitions: result.transitions, explanations };
}

const CANDIDATES: RuleSet[] = [
  { weights: [40, 25, 20, 10, 15, 10], midThreshold: 40, highThreshold: 70 },
  { weights: [25, 20, 15, 10, 15, 10], midThreshold: 80, highThreshold: 90 },
  { weights: [60, 0, 0, 0, 0, 10], midThreshold: 40, highThreshold: 70 },
  { weights: [0, 0, 0, 0, 0, 0], midThreshold: 1, highThreshold: 2 },
  { weights: [100, 100, 100, 100, 100, 100], midThreshold: 0, highThreshold: 100 },
  { weights: [10, 90, 5, 50, 0, 33], midThreshold: 55, highThreshold: 61 },
];

test("聚合预览与逐学生重算一致", () => {
  const students = makeStudents(20000);
  const engine = new RulePreviewEngine(students);
  for (const candidate of CANDIDATES) {
    const expected = recomputePerStudent(students, candidate);
    assert.deepEqual(normalize(engine.preview(candidate)), normalize(expected));
  }
});

test("解释人数之和可以超过迁移人数（同一学生多份解释分别计数）", () => {
  // 前三项命中的学生在方案1下有两份解释
  const students: StudentSnapshot[] = [{
    studentId: "only",
    gpaBelow2: true,
    attendanceBelow75: true,
    aidIncomplete: true,
    undeclaredOver30: false,
    withdrew2Plus: false,
    firstGen: false,
  }];
  const engine = new RulePreviewEngine(students);
  const result = engine.preview({ weights: [40, 25, 20, 10, 15, 10], midThreshold: 40, highThreshold: 70 });
  assert.equal(result.transitions.medium.high, 1);
  const list = result.explanations["medium->high"];
  assert.equal(list?.length, 2);
  assert.equal((list ?? []).reduce((sum, e) => sum + e.count, 0), 2);
});

test("多次预览不污染基准，各方案相互独立", () => {
  const students = makeStudents(5000, 99);
  const engine = new RulePreviewEngine(students);
  const first = normalize(engine.preview(CANDIDATES[0]));
  for (const candidate of CANDIDATES) engine.preview(candidate);
  // 基准规则未被修改
  assert.deepEqual(engine.baselineRules, BASELINE_RULES);
  // 重复预览结果一致
  assert.deepEqual(normalize(engine.preview(CANDIDATES[0])), first);
  // 单学生查询也不受之前预览影响
  const direct = engine.previewStudent(CANDIDATES[0], "S0");
  assert.equal(direct.baselineScore, scoreOf(flagsOf(students[0]), BASELINE_RULES));
});

test("按学号查询：前后分数、档位与解释", () => {
  const students: StudentSnapshot[] = [{
    studentId: "stu-1",
    gpaBelow2: true,
    attendanceBelow75: true,
    aidIncomplete: true,
    undeclaredOver30: false,
    withdrew2Plus: false,
    firstGen: false,
  }];
  const engine = new RulePreviewEngine(students);
  const candidate: RuleSet = { weights: [40, 25, 20, 10, 15, 10], midThreshold: 40, highThreshold: 70 };
  const view = engine.previewStudent(candidate, "stu-1");
  assert.equal(view.baselineScore, 60);
  assert.equal(view.baselineTier, "medium");
  assert.equal(view.candidateScore, 85);
  assert.equal(view.candidateTier, "high");
  assert.deepEqual(
    view.explanations.map((e) => [...e.parameters].sort().join("+")).sort(),
    ["aidWeight+attendanceWeight", "gpaWeight"],
  );
  // 不换档时无解释
  const same = engine.previewStudent(BASELINE_RULES, "stu-1");
  assert.equal(same.explanations.length, 0);
  assert.throws(() => engine.previewStudent(candidate, "missing"));
});

test("重复学号与非法方案被拒绝", () => {
  const s: StudentSnapshot = {
    studentId: "x",
    gpaBelow2: false,
    attendanceBelow75: false,
    aidIncomplete: false,
    undeclaredOver30: false,
    withdrew2Plus: false,
    firstGen: false,
  };
  assert.throws(() => new RulePreviewEngine([s, s]));
  const engine = new RulePreviewEngine([s]);
  assert.throws(() => engine.preview({ weights: [25, 20, 15, 10, 15, 10], midThreshold: 90, highThreshold: 80 }));
});
