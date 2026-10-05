import { Attempts, GradingRule } from './types';

/** 按策略为单项选分：最高分或最后一次。 */
export function selectScore(scores: number[], strategy: GradingRule['strategy']): number {
  if (strategy === 'last') {
    return scores[scores.length - 1];
  }
  let best = scores[0];
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > best) best = scores[i];
  }
  return best;
}

/**
 * 按规则计算总分与是否及格。
 * 权重与及格线均为整数，内部用“总分×100”的整数运算判定及格，避免浮点误差。
 */
export function computeResult(rule: GradingRule, attempts: Attempts): { total: number; passed: boolean } {
  const homework = selectScore(attempts.homework, rule.strategy);
  const midterm = selectScore(attempts.midterm, rule.strategy);
  const final = selectScore(attempts.final, rule.strategy);
  const totalTimes100 =
    homework * rule.weights.homework + midterm * rule.weights.midterm + final * rule.weights.final;
  return {
    total: totalTimes100 / 100,
    passed: totalTimes100 >= rule.passLine * 100,
  };
}
