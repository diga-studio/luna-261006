import type { QuestionBank, QuestionVersion } from "./types.js";

function copyQuestion(q: QuestionVersion): QuestionVersion {
  return {
    questionId: q.questionId,
    version: q.version,
    category: q.category,
    difficulty: q.difficulty,
  };
}

/**
 * 建立题库快照：
 * - 深拷贝输入，调用方随后修改原始输入不影响快照；
 * - 同一 questionId 只保留最大 version，旧版不作为额外候选；
 * - 快照内题目按 questionId 排序，结果与输入顺序无关。
 */
export function snapshotBank(versions: readonly QuestionVersion[]): QuestionBank {
  const latest = new Map<string, QuestionVersion>();
  for (const q of versions) {
    const prev = latest.get(q.questionId);
    if (prev === undefined || q.version > prev.version) {
      latest.set(q.questionId, copyQuestion(q));
    }
  }
  const questions = [...latest.values()].sort((a, b) =>
    a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0,
  );
  return { questions };
}
