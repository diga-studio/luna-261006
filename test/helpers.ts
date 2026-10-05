import { questionCost } from "../src/cost.js";
import type {
  CategoryCounts,
  DifficultyCounts,
  QuestionVersion,
} from "../src/types.js";

export interface ExhaustiveBest {
  /** 最优（重复数, 成本）字典序最小值；null 表示无解。 */
  repeats: number;
  totalCost: bigint;
  /** 达到最优的试卷份数。 */
  count: number;
}

/**
 * 独立穷举：枚举所有题目子集，筛出精确满足两侧配额的合法试卷，
 * 返回字典序最小的 (重复题数, 随机成本总和)。无解返回 null。
 */
export function exhaustiveBest(
  versions: readonly QuestionVersion[],
  categoryCounts: CategoryCounts,
  difficultyCounts: DifficultyCounts,
  history: readonly (readonly string[])[],
  seed: string,
): ExhaustiveBest | null {
  const latest = new Map<string, QuestionVersion>();
  for (const q of versions) {
    const prev = latest.get(q.questionId);
    if (prev === undefined || q.version > prev.version) latest.set(q.questionId, q);
  }
  const pool = [...latest.values()];
  const historySet = new Set<string>();
  for (const exam of history) for (const id of exam) historySet.add(id);

  const categories = Object.keys(categoryCounts).filter((c) => categoryCounts[c]! > 0);
  const difficulties = Object.keys(difficultyCounts).filter(
    (d) => (difficultyCounts as Record<string, number>)[d]! > 0,
  );

  let best: { repeats: number; totalCost: bigint } | null = null;
  let count = 0;

  const n = pool.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const catUsed = new Map<string, number>();
    const diffUsed = new Map<string, number>();
    let repeats = 0;
    let cost = 0n;
    let size = 0;
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const q = pool[i]!;
      size += 1;
      catUsed.set(q.category, (catUsed.get(q.category) ?? 0) + 1);
      diffUsed.set(q.difficulty, (diffUsed.get(q.difficulty) ?? 0) + 1);
      if (historySet.has(q.questionId)) repeats += 1;
      cost += BigInt(questionCost(seed, q.questionId));
    }
    if (categories.some((c) => (catUsed.get(c) ?? 0) !== categoryCounts[c]!)) continue;
    if (difficulties.some((d) => (diffUsed.get(d) ?? 0) !== (difficultyCounts as Record<string, number>)[d]!)) continue;
    // 未列入配额的类别/难度必须为 0
    if ([...catUsed.keys()].some((c) => !categories.includes(c))) continue;
    if ([...diffUsed.keys()].some((d) => !difficulties.includes(d))) continue;
    void size;
    if (best === null || repeats < best.repeats || (repeats === best.repeats && cost < best.totalCost)) {
      best = { repeats, totalCost: cost };
      count = 1;
    } else if (repeats === best.repeats && cost === best.totalCost) {
      count += 1;
    }
  }
  return best === null ? null : { ...best, count };
}

/** 简单可复现的伪随机数生成器（mulberry32）。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用 rng 确定性打乱数组（返回新数组）。 */
export function shuffled<T>(arr: readonly T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
