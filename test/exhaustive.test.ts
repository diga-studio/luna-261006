import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { assembleExam, snapshotBank } from "../src/index.js";
import type { QuestionVersion, Quota } from "../src/index.js";

function costOf(seed: string, questionId: string): bigint {
  const digest = createHash("sha256")
    .update(JSON.stringify([seed, questionId]), "utf8")
    .digest();
  return BigInt(digest.readUInt32BE(0));
}

interface BruteForceBest {
  repeats: number;
  cost: bigint;
}

function bruteForce(
  questions: readonly QuestionVersion[],
  categoryCounts: Quota,
  difficultyCounts: Quota,
  historyIds: ReadonlySet<string>,
  seed: string
): BruteForceBest | null {
  const total =
    Object.values(categoryCounts).reduce((s, n) => s + n, 0);
  let best: BruteForceBest | null = null;
  const chosen: QuestionVersion[] = [];
  function visit(index: number): void {
    if (chosen.length > total) return;
    if (index === questions.length) {
      if (chosen.length !== total) return;
      const catCount = new Map<string, number>();
      const diffCount = new Map<string, number>();
      const ids = new Set<string>();
      for (const q of chosen) {
        if (ids.has(q.questionId)) return;
        ids.add(q.questionId);
        catCount.set(q.category, (catCount.get(q.category) ?? 0) + 1);
        diffCount.set(q.difficulty, (diffCount.get(q.difficulty) ?? 0) + 1);
      }
      for (const [c, n] of Object.entries(categoryCounts)) {
        if ((catCount.get(c) ?? 0) !== n) return;
      }
      for (const c of catCount.keys()) {
        if (!(c in categoryCounts) || categoryCounts[c] !== catCount.get(c)) return;
      }
      for (const [d, n] of Object.entries(difficultyCounts)) {
        if ((diffCount.get(d) ?? 0) !== n) return;
      }
      for (const d of diffCount.keys()) {
        if (!(d in difficultyCounts) || difficultyCounts[d] !== diffCount.get(d)) return;
      }
      let repeats = 0;
      let cost = 0n;
      for (const q of chosen) {
        if (historyIds.has(q.questionId)) repeats += 1;
        cost += costOf(seed, q.questionId);
      }
      if (
        best === null ||
        repeats < best.repeats ||
        (repeats === best.repeats && cost < best.cost)
      ) {
        best = { repeats, cost };
      }
      return;
    }
    visit(index + 1);
    chosen.push(questions[index]!);
    visit(index + 1);
    chosen.pop();
  }
  visit(0);
  return best;
}

function actualCost(
  result: { readonly questions: readonly QuestionVersion[] },
  historyIds: ReadonlySet<string>,
  seed: string
): BruteForceBest {
  let repeats = 0;
  let cost = 0n;
  const ids = new Set<string>();
  for (const q of result.questions) {
    assert.ok(!ids.has(q.questionId), "exam must not repeat a questionId");
    ids.add(q.questionId);
    if (historyIds.has(q.questionId)) repeats += 1;
    cost += costOf(seed, q.questionId);
  }
  return { repeats, cost };
}

function checkQuotas(
  result: { readonly questions: readonly QuestionVersion[] },
  categoryCounts: Quota,
  difficultyCounts: Quota
): void {
  const catCount = new Map<string, number>();
  const diffCount = new Map<string, number>();
  for (const q of result.questions) {
    catCount.set(q.category, (catCount.get(q.category) ?? 0) + 1);
    diffCount.set(q.difficulty, (diffCount.get(q.difficulty) ?? 0) + 1);
  }
  for (const [c, n] of Object.entries(categoryCounts)) {
    assert.equal(catCount.get(c) ?? 0, n, `category ${c}`);
  }
  for (const c of catCount.keys()) {
    assert.ok((categoryCounts[c] ?? 0) > 0, `unexpected category ${c}`);
  }
  for (const [d, n] of Object.entries(difficultyCounts)) {
    assert.equal(diffCount.get(d) ?? 0, n, `difficulty ${d}`);
  }
  for (const d of diffCount.keys()) {
    assert.ok((difficultyCounts[d] ?? 0) > 0, `unexpected difficulty ${d}`);
  }
}

const BANK: QuestionVersion[] = [
  { questionId: "a1", version: 1, category: "数学", difficulty: "基础" },
  { questionId: "a2", version: 1, category: "数学", difficulty: "进阶" },
  { questionId: "a3", version: 2, category: "数学", difficulty: "高阶" },
  { questionId: "a3", version: 1, category: "数学", difficulty: "基础" },
  { questionId: "b1", version: 1, category: "物理", difficulty: "基础" },
  { questionId: "b2", version: 1, category: "物理", difficulty: "进阶" },
  { questionId: "b3", version: 1, category: "物理", difficulty: "高阶" },
  { questionId: "c1", version: 1, category: "化学", difficulty: "基础" },
  { questionId: "c2", version: 3, category: "化学", difficulty: "进阶" },
  { questionId: "c2", version: 2, category: "化学", difficulty: "高阶" },
  { questionId: "d1", version: 1, category: "生物", difficulty: "高阶" },
  { questionId: "e1", version: 1, category: "天文", difficulty: "基础" },
];

const CASES: ReadonlyArray<{
  name: string;
  categoryCounts: Quota;
  difficultyCounts: Quota;
  history: string[][];
  seed: string;
}> = [
  {
    name: "feasible with history avoidance",
    categoryCounts: { 数学: 2, 物理: 1 },
    difficultyCounts: { 基础: 1, 进阶: 1, 高阶: 1 },
    history: [["a1", "b1"]],
    seed: "seed-1",
  },
  {
    name: "forced repeats",
    categoryCounts: { 数学: 2 },
    difficultyCounts: { 基础: 1, 进阶: 1 },
    history: [["a1", "a2", "a3"]],
    seed: "seed-2",
  },
  {
    name: "infeasible: pools sufficient alone, joint impossible",
    categoryCounts: { 天文: 1, 生物: 1 },
    difficultyCounts: { 基础: 2 },
    history: [],
    seed: "seed-3",
  },
  {
    name: "infeasible: not enough questions in category",
    categoryCounts: { 生物: 2 },
    difficultyCounts: { 高阶: 2 },
    history: [],
    seed: "seed-4",
  },
  {
    name: "empty exam",
    categoryCounts: {},
    difficultyCounts: {},
    history: [],
    seed: "seed-5",
  },
  {
    name: "uses only latest version of a3 and c2",
    categoryCounts: { 数学: 1, 化学: 1 },
    difficultyCounts: { 高阶: 1, 进阶: 1 },
    history: [],
    seed: "seed-6",
  },
];

for (const c of CASES) {
  test(`assembleExam matches brute force: ${c.name}`, () => {
    const bank = snapshotBank(BANK);
    const historyIds = new Set(c.history.flat());
    const expected = bruteForce(
      bank.questions,
      c.categoryCounts,
      c.difficultyCounts,
      historyIds,
      c.seed
    );
    const result = assembleExam(
      bank,
      c.categoryCounts,
      c.difficultyCounts,
      c.history,
      c.seed
    );
    if (expected === null) {
      assert.ok(!result.ok, "expected no feasible exam");
      return;
    }
    assert.ok(result.ok, "expected a feasible exam");
    checkQuotas(result, c.categoryCounts, c.difficultyCounts);
    const actual = actualCost(result, historyIds, c.seed);
    assert.equal(actual.repeats, expected.repeats, "repeat count must be minimal");
    assert.equal(actual.cost, expected.cost, "random cost must be minimal among min-repeat exams");
  });
}

test("joint infeasibility fixture really has sufficient separate pools", () => {
  const bank = snapshotBank(BANK);
  const byCategory = new Map<string, number>();
  const byDifficulty = new Map<string, number>();
  for (const q of bank.questions) {
    byCategory.set(q.category, (byCategory.get(q.category) ?? 0) + 1);
    byDifficulty.set(q.difficulty, (byDifficulty.get(q.difficulty) ?? 0) + 1);
  }
  assert.ok((byCategory.get("天文") ?? 0) >= 1);
  assert.ok((byCategory.get("生物") ?? 0) >= 1);
  assert.ok((byDifficulty.get("基础") ?? 0) >= 2);
  const result = assembleExam(
    bank,
    { 天文: 1, 生物: 1 },
    { 基础: 2 },
    [],
    "seed-3"
  );
  assert.ok(!result.ok);
});
