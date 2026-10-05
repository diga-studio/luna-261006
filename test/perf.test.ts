import assert from "node:assert/strict";
import test from "node:test";
import {
  BASELINE_RULES,
  RulePreviewEngine,
  scoreOf,
  tierOf,
  type RuleSet,
  type StudentSnapshot,
} from "../src/index.js";

const STUDENT_COUNT = 1_000_000;
const CANDIDATE_COUNT = 1_000;
const BUDGET_MS = 10_000;

function makeStudents(count: number): StudentSnapshot[] {
  let state = 20261005;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const students: StudentSnapshot[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    students[i] = {
      studentId: `S${i}`,
      gpaBelow2: rand() < 0.3,
      attendanceBelow75: rand() < 0.3,
      aidIncomplete: rand() < 0.3,
      undeclaredOver30: rand() < 0.3,
      withdrew2Plus: rand() < 0.3,
      firstGen: rand() < 0.3,
    };
  }
  return students;
}

function makeCandidates(count: number): RuleSet[] {
  let state = 777;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const candidates: RuleSet[] = [];
  const seen = new Set<string>();
  while (candidates.length < count) {
    const mid = randInt(0, 99);
    const candidate: RuleSet = {
      weights: [randInt(0, 100), randInt(0, 100), randInt(0, 100), randInt(0, 100), randInt(0, 100), randInt(0, 100)],
      midThreshold: mid,
      highThreshold: randInt(mid + 1, 100),
    };
    const key = JSON.stringify(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

test("性能：100 万学生载入后 1000 个候选方案完整预览总耗时 <= 10s", { timeout: 120_000 }, () => {
  const students = makeStudents(STUDENT_COUNT);
  const engine = new RulePreviewEngine(students);
  const candidates = makeCandidates(CANDIDATE_COUNT);

  const start = performance.now();
  let transitionTotal = 0;
  let explanationTotal = 0;
  for (const candidate of candidates) {
    const result = engine.preview(candidate);
    for (const from of Object.values(result.transitions)) {
      for (const n of Object.values(from)) transitionTotal += n;
    }
    for (const list of Object.values(result.explanations)) {
      for (const e of list ?? []) explanationTotal += e.count;
    }
  }
  const elapsedMs = performance.now() - start;

  console.log(
    `[perf] ${STUDENT_COUNT} students x ${CANDIDATE_COUNT} full previews: ${elapsedMs.toFixed(1)}ms ` +
      `(budget ${BUDGET_MS}ms), transitions counted=${transitionTotal}, explanations counted=${explanationTotal}`,
  );
  assert.equal(transitionTotal, STUDENT_COUNT * CANDIDATE_COUNT);
  assert.ok(explanationTotal > 0, "每次预览都必须包含解释人数统计");
  assert.ok(elapsedMs <= BUDGET_MS, `preview total ${elapsedMs.toFixed(1)}ms exceeds ${BUDGET_MS}ms`);
});

test("性能规模下迁移人数与逐学生重算一致", { timeout: 120_000 }, () => {
  const students = makeStudents(STUDENT_COUNT);
  const engine = new RulePreviewEngine(students);
  const candidates = makeCandidates(20);

  for (const candidate of candidates) {
    const result = engine.preview(candidate);
    const expected = Object.fromEntries(["low", "medium", "high"].map((t) => [t, Object.fromEntries(["low", "medium", "high"].map((u) => [u, 0]))])) as Record<string, Record<string, number>>;
    for (const s of students) {
      const from = tierOf(scoreOf(s, BASELINE_RULES), BASELINE_RULES);
      const to = tierOf(scoreOf(s, candidate), candidate);
      expected[from][to] += 1;
    }
    assert.deepEqual(result.transitions, expected);
  }
});
