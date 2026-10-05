import type { QuestionBank, QuestionVersion } from "./types.js";

export function snapshotBank(versions: readonly QuestionVersion[]): QuestionBank {
  const sorted = [...versions].sort((a, b) => {
    if (a.questionId !== b.questionId) {
      return a.questionId < b.questionId ? -1 : 1;
    }
    if (a.version !== b.version) return b.version - a.version;
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return a.difficulty < b.difficulty ? -1 : 1;
  });
  const questions: QuestionVersion[] = [];
  let seenId: string | null = null;
  for (const v of sorted) {
    if (v.questionId === seenId) continue;
    seenId = v.questionId;
    questions.push({
      questionId: v.questionId,
      version: v.version,
      category: v.category,
      difficulty: v.difficulty,
    });
  }
  return { questions };
}
