"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeResult = exports.selectScore = void 0;
/** 按策略为单项选分：最高分或最后一次。 */
function selectScore(scores, strategy) {
    if (strategy === 'last') {
        return scores[scores.length - 1];
    }
    let best = scores[0];
    for (let i = 1; i < scores.length; i++) {
        if (scores[i] > best)
            best = scores[i];
    }
    return best;
}
exports.selectScore = selectScore;
/**
 * 按规则计算总分与是否及格。
 * 权重与及格线均为整数，内部用“总分×100”的整数运算判定及格，避免浮点误差。
 */
function computeResult(rule, attempts) {
    const homework = selectScore(attempts.homework, rule.strategy);
    const midterm = selectScore(attempts.midterm, rule.strategy);
    const final = selectScore(attempts.final, rule.strategy);
    const totalTimes100 = homework * rule.weights.homework + midterm * rule.weights.midterm + final * rule.weights.final;
    return {
        total: totalTimes100 / 100,
        passed: totalTimes100 >= rule.passLine * 100,
    };
}
exports.computeResult = computeResult;
