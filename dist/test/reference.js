"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.referenceGradebook = exports.referenceRow = void 0;
/** 测试内独立实现的串行参考计算（不复用被测代码）。 */
function referenceRow(rule, attempts, inputVersion) {
    const pick = (scores) => rule.strategy === 'last' ? scores[scores.length - 1] : Math.max(...scores);
    const total = (pick(attempts.homework) * rule.weights.homework +
        pick(attempts.midterm) * rule.weights.midterm +
        pick(attempts.final) * rule.weights.final) /
        100;
    return { inputVersion, total, passed: total >= rule.passLine };
}
exports.referenceRow = referenceRow;
/** 依据测试自维护的最新输入，生成期望的完整成绩簿。 */
function referenceGradebook(rule, inputs) {
    const rows = {};
    for (const [studentId, input] of inputs) {
        rows[studentId] = referenceRow(rule, input.attempts, input.inputVersion);
    }
    return rows;
}
exports.referenceGradebook = referenceGradebook;
