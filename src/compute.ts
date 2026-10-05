import { Attempts, Rule, Strategy } from "./types";

export function selectScore(strategy: Strategy, scores: number[]): number {
  if (strategy === "max") {
    let best = scores[0];
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > best) best = scores[i];
    }
    return best;
  }
  return scores[scores.length - 1];
}

export function computeScore(rule: Rule, attempts: Attempts): { total: number; pass: boolean } {
  const homework = selectScore(rule.strategy, attempts.homework);
  const midterm = selectScore(rule.strategy, attempts.midterm);
  const final = selectScore(rule.strategy, attempts.final);
  const total =
    (homework * rule.weights.homework +
      midterm * rule.weights.midterm +
      final * rule.weights.final) / 100;
  return { total, pass: total >= rule.passLine };
}
