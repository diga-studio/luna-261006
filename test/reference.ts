import { Attempts, GradebookRow, GradingRule } from '../src/types';

/** 测试内独立实现的串行参考计算（不复用被测代码）。 */
export function referenceRow(
  rule: GradingRule,
  attempts: Attempts,
  inputVersion: number,
): GradebookRow {
  const pick = (scores: number[]): number =>
    rule.strategy === 'last' ? scores[scores.length - 1] : Math.max(...scores);
  const total =
    (pick(attempts.homework) * rule.weights.homework +
      pick(attempts.midterm) * rule.weights.midterm +
      pick(attempts.final) * rule.weights.final) /
    100;
  return { inputVersion, total, passed: total >= rule.passLine };
}

/** 依据测试自维护的最新输入，生成期望的完整成绩簿。 */
export function referenceGradebook(
  rule: GradingRule,
  inputs: Map<string, { inputVersion: number; attempts: Attempts }>,
): Record<string, GradebookRow> {
  const rows: Record<string, GradebookRow> = {};
  for (const [studentId, input] of inputs) {
    rows[studentId] = referenceRow(rule, input.attempts, input.inputVersion);
  }
  return rows;
}
