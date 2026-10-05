import { questionCost } from "./cost.js";
import { minCostFlow, type FlowEdge } from "./mincostflow.js";
import {
  DIFFICULTIES,
  type AssembleResult,
  type CategoryCounts,
  type DifficultyCounts,
  type QuestionBank,
} from "./types.js";

function isValidCounts(counts: Readonly<Record<string, unknown>>): boolean {
  return Object.values(counts).every(
    (v) => typeof v === "number" && Number.isInteger(v) && v >= 0,
  );
}

function noSolution(reason: string): AssembleResult {
  return { ok: false, reason };
}

/**
 * 生成试卷。两级目标按字典序优化：先最小化重复题数量，再最小化随机成本总和。
 * 建模为最小费用流：源→类别（容量=类别配额），类别→难度（每题一条容量 1 的边，
 * 成本 = 重复标记 * BIG + 随机成本，BIG 大于一切可能的随机成本总和），难度→汇
 * （容量=难度配额）。流量不足配额总数即无解，绝不返回部分试卷。
 */
export function assembleExam(
  bank: QuestionBank,
  categoryCounts: CategoryCounts,
  difficultyCounts: DifficultyCounts,
  history: readonly (readonly string[])[],
  seed: string,
): AssembleResult {
  if (!isValidCounts(categoryCounts)) {
    return noSolution("类别配额必须是非负整数");
  }
  const difficultyKeys = Object.keys(difficultyCounts);
  if (
    !difficultyKeys.every((k) => (DIFFICULTIES as readonly string[]).includes(k)) ||
    !isValidCounts(difficultyCounts)
  ) {
    return noSolution("难度配额必须是非负整数，且难度只能是 基础/进阶/高阶");
  }

  const categories = Object.keys(categoryCounts)
    .filter((c) => categoryCounts[c]! > 0)
    .sort();
  const difficulties = DIFFICULTIES.filter((d) => (difficultyCounts[d] ?? 0) > 0);

  const categoryTotal = categories.reduce((s, c) => s + categoryCounts[c]!, 0);
  const difficultyTotal = difficulties.reduce((s, d) => s + difficultyCounts[d]!, 0);
  if (categoryTotal !== difficultyTotal) {
    return noSolution("类别配额总数与难度配额总数不一致");
  }

  const historySet = new Set<string>();
  for (const exam of history) {
    for (const id of exam) historySet.add(id);
  }

  // 题目按 questionId 排序，保证结果与输入顺序无关。
  const questions = [...bank.questions].sort((a, b) =>
    a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0,
  );

  if (categoryTotal === 0) {
    return { ok: true, questions: [], repeats: 0, totalCost: 0n };
  }

  const source = 0;
  const categoryBase = 1;
  const difficultyBase = categoryBase + categories.length;
  const sink = difficultyBase + difficulties.length;
  const nodeCount = sink + 1;

  const categoryNode = new Map(categories.map((c, i) => [c, categoryBase + i]));
  const difficultyNode = new Map(difficulties.map((d, i) => [d, difficultyBase + i]));

  // BIG 大于任何可能的随机成本总和（每题成本 < 2^32）。
  const big = BigInt(Math.max(questions.length, 1)) << 32n;

  const edges: FlowEdge[] = [];
  for (const c of categories) {
    edges.push({ from: source, to: categoryNode.get(c)!, capacity: categoryCounts[c]!, cost: 0n });
  }
  // questionEdges[i] = 题目边在 edges 中的下标；-1 表示该题不可用于当前配额。
  const questionEdges = new Array<number>(questions.length).fill(-1);
  const repeatFlags = new Array<boolean>(questions.length).fill(false);
  const randCosts = new Array<number>(questions.length).fill(0);
  questions.forEach((q, i) => {
    const catNode = categoryNode.get(q.category);
    const diffNode = difficultyNode.get(q.difficulty);
    if (catNode === undefined || diffNode === undefined) return;
    const repeat = historySet.has(q.questionId);
    const rand = questionCost(seed, q.questionId);
    repeatFlags[i] = repeat;
    randCosts[i] = rand;
    questionEdges[i] = edges.length;
    edges.push({
      from: catNode,
      to: diffNode,
      capacity: 1,
      cost: (repeat ? big : 0n) + BigInt(rand),
    });
  });
  for (const d of difficulties) {
    edges.push({ from: difficultyNode.get(d)!, to: sink, capacity: difficultyCounts[d]!, cost: 0n });
  }

  const result = minCostFlow(nodeCount, source, sink, categoryTotal, edges);
  if (result.flow < categoryTotal) {
    return noSolution("题库在类别与难度配额约束下不存在合法试卷");
  }

  const picked: number[] = [];
  questions.forEach((q, i) => {
    const edgeIndex = questionEdges[i]!;
    if (edgeIndex >= 0 && result.used[edgeIndex]! > 0) picked.push(i);
  });

  let repeats = 0;
  let totalCost = 0n;
  const exam = picked.map((i) => {
    if (repeatFlags[i]!) repeats += 1;
    totalCost += BigInt(randCosts[i]!);
    const q = questions[i]!;
    return {
      questionId: q.questionId,
      version: q.version,
      category: q.category,
      difficulty: q.difficulty,
    };
  });

  return { ok: true, questions: exam, repeats, totalCost };
}
