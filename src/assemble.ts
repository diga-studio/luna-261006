import { createHash } from "node:crypto";
import type {
  AssembleResult,
  Difficulty,
  QuestionBank,
  QuestionVersion,
  Quota,
} from "./types.js";

const DIFFICULTIES: readonly Difficulty[] = ["基础", "进阶", "高阶"];

function randomCost(seed: string, questionId: string): bigint {
  const digest = createHash("sha256")
    .update(JSON.stringify([seed, questionId]), "utf8")
    .digest();
  return BigInt(digest.readUInt32BE(0));
}

function isValidQuota(quota: Quota): boolean {
  return Object.values(quota).every(
    (n) => typeof n === "number" && Number.isInteger(n) && n >= 0
  );
}

interface CellEntry {
  readonly question: QuestionVersion;
  readonly repeat: boolean;
  readonly cost: bigint;
}

interface Cell {
  readonly entries: readonly CellEntry[];
  readonly repeatPrefix: readonly number[];
  readonly costPrefix: readonly bigint[];
}

function compareIdLists(
  a: readonly QuestionVersion[],
  b: readonly QuestionVersion[]
): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i].questionId !== b[i].questionId) {
      return a[i].questionId < b[i].questionId ? -1 : 1;
    }
  }
  return a.length - b.length;
}

export function assembleExam(
  bank: QuestionBank,
  categoryCounts: Quota,
  difficultyCounts: Quota,
  history: readonly (readonly string[])[],
  seed: string
): AssembleResult {
  if (!isValidQuota(categoryCounts) || !isValidQuota(difficultyCounts)) {
    return { ok: false, reason: "invalid quota: counts must be non-negative integers" };
  }
  for (const key of Object.keys(difficultyCounts)) {
    if (!DIFFICULTIES.includes(key as Difficulty)) {
      return { ok: false, reason: `unknown difficulty: ${key}` };
    }
  }
  const categories = Object.keys(categoryCounts)
    .filter((c) => categoryCounts[c]! > 0)
    .sort();
  const difficultyNeed = DIFFICULTIES.map((d) => difficultyCounts[d] ?? 0);
  const categoryTotal = categories.reduce((s, c) => s + categoryCounts[c]!, 0);
  const difficultyTotal = difficultyNeed.reduce((s, n) => s + n, 0);
  if (categoryTotal !== difficultyTotal) {
    return { ok: false, reason: "quota totals differ" };
  }

  const historyIds = new Set<string>();
  for (const exam of history) {
    for (const id of exam) historyIds.add(id);
  }

  const cellKey = (category: string, di: number) => `${category}${DIFFICULTIES[di]}`;
  const rawCells = new Map<string, CellEntry[]>();
  for (const q of bank.questions) {
    const di = DIFFICULTIES.indexOf(q.difficulty);
    if (di < 0) continue;
    const key = cellKey(q.category, di);
    let list = rawCells.get(key);
    if (!list) rawCells.set(key, (list = []));
    list.push({
      question: q,
      repeat: historyIds.has(q.questionId),
      cost: randomCost(seed, q.questionId),
    });
  }
  const cells = new Map<string, Cell>();
  for (const [key, entries] of rawCells) {
    entries.sort((a, b) => {
      if (a.repeat !== b.repeat) return a.repeat ? 1 : -1;
      if (a.cost !== b.cost) return a.cost < b.cost ? -1 : 1;
      return a.question.questionId < b.question.questionId ? -1 : 1;
    });
    const repeatPrefix: number[] = [0];
    const costPrefix: bigint[] = [0n];
    for (const e of entries) {
      repeatPrefix.push(repeatPrefix[repeatPrefix.length - 1]! + (e.repeat ? 1 : 0));
      costPrefix.push(costPrefix[costPrefix.length - 1]! + e.cost);
    }
    cells.set(key, { entries, repeatPrefix, costPrefix });
  }
  const capacity = (category: string, di: number): number =>
    cells.get(cellKey(category, di))?.entries.length ?? 0;

  let best: { repeats: number; cost: bigint; picks: QuestionVersion[] } | null = null;
  const allocation = new Array<number>(categories.length * DIFFICULTIES.length).fill(0);
  const remaining = [...difficultyNeed];

  function consider(): void {
    let repeats = 0;
    let cost = 0n;
    for (let ci = 0; ci < categories.length; ci++) {
      for (let di = 0; di < DIFFICULTIES.length; di++) {
        const take = allocation[ci * DIFFICULTIES.length + di]!;
        if (take === 0) continue;
        const cell = cells.get(cellKey(categories[ci]!, di))!;
        repeats += cell.repeatPrefix[take]!;
        cost += cell.costPrefix[take]!;
      }
    }
    if (best !== null) {
      if (repeats > best.repeats) return;
      if (repeats === best.repeats && cost > best.cost) return;
    }
    const picks: QuestionVersion[] = [];
    for (let ci = 0; ci < categories.length; ci++) {
      for (let di = 0; di < DIFFICULTIES.length; di++) {
        const take = allocation[ci * DIFFICULTIES.length + di]!;
        if (take === 0) continue;
        const cell = cells.get(cellKey(categories[ci]!, di))!;
        for (let k = 0; k < take; k++) picks.push(cell.entries[k]!.question);
      }
    }
    picks.sort((a, b) => (a.questionId < b.questionId ? -1 : 1));
    if (
      best !== null &&
      repeats === best.repeats &&
      cost === best.cost &&
      compareIdLists(picks, best.picks) >= 0
    ) {
      return;
    }
    best = { repeats, cost, picks };
  }

  function distribute(ci: number, di: number, left: number): void {
    if (di === DIFFICULTIES.length) {
      if (left !== 0) return;
      if (ci + 1 === categories.length) {
        consider();
      } else {
        distribute(ci + 1, 0, categoryCounts[categories[ci + 1]!]!);
      }
      return;
    }
    const cap = Math.min(capacity(categories[ci]!, di), remaining[di]!, left);
    const stillNeeded = left - cap;
    let laterRoom = 0;
    for (let dj = di + 1; dj < DIFFICULTIES.length; dj++) {
      laterRoom += Math.min(capacity(categories[ci]!, dj), remaining[dj]!);
    }
    if (stillNeeded > laterRoom) return;
    const minTake = Math.max(0, left - laterRoom);
    for (let take = minTake; take <= cap; take++) {
      allocation[ci * DIFFICULTIES.length + di] = take;
      remaining[di]! -= take;
      distribute(ci, di + 1, left - take);
      remaining[di]! += take;
    }
    allocation[ci * DIFFICULTIES.length + di] = 0;
  }

  if (categories.length === 0) {
    if (categoryTotal === 0) {
      best = { repeats: 0, cost: 0n, picks: [] };
    }
  } else {
    distribute(0, 0, categoryCounts[categories[0]!]!);
  }

  if (best === null) {
    return { ok: false, reason: "no feasible exam satisfies both quotas" };
  }
  const finalBest = best as { picks: QuestionVersion[] };
  return {
    ok: true,
    questions: finalBest.picks.map((q) => ({
      questionId: q.questionId,
      version: q.version,
      category: q.category,
      difficulty: q.difficulty,
    })),
  };
}
