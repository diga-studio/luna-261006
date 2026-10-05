import { Attempts, Rule } from "../../src/types";

/** Independent serial oracle used by tests to cross-check the service. */
export function referenceScore(
  rule: Rule,
  attempts: Attempts
): { total: number; pass: boolean } {
  const pick = (scores: number[]): number =>
    rule.strategy === "max"
      ? scores.reduce((a, b) => (b > a ? b : a), scores[0])
      : scores[scores.length - 1];
  const total =
    (pick(attempts.homework) * rule.weights.homework +
      pick(attempts.midterm) * rule.weights.midterm +
      pick(attempts.final) * rule.weights.final) /
    100;
  return { total, pass: total >= rule.passLine };
}
