import type { CompiledPolicy } from "./compile.js";
import { evalExpr } from "./expr.js";
import type { Completion, Snapshot } from "./schema.js";

/**
 * 判定结论：
 * - NA:      没有适用补全
 * - Pass:    存在适用补全，且 required 在其中始终为真
 * - Fail:    存在适用补全，且 required 在其中始终为假
 * - Warning: 存在 required 分别为真和假的适用补全
 */
export type Conclusion = "NA" | "Pass" | "Fail" | "Warning";

/**
 * 判定结果。见证（witness）是完整补全，可用普通布尔求值独立核验：
 * - Pass:    witness 使 applicable∧required 为真
 * - Fail:    witness 使 applicable∧¬required 为真
 * - Warning: passWitness / failWitness 各一个
 * - NA:      不返回补全
 */
export type Evaluation =
  | { conclusion: "NA" }
  | { conclusion: "Pass"; witness: Completion }
  | { conclusion: "Fail"; witness: Completion }
  | { conclusion: "Warning"; passWitness: Completion; failWitness: Completion };

/**
 * 在 snapshot（部分已知值）下判定编译后的策略。
 *
 * 对每个被引用字段，只需考察编译期划分的单元代表值（已知值则固定），
 * 即可精确覆盖全部合法补全：同一单元内的值对所有原子真值相同。
 * 找到一对（required 真 / 假）适用补全即可提前终止（Warning）。
 */
export function evaluate(compiled: CompiledPolicy, snapshot: Snapshot): Evaluation {
  const { plans, applicable, required, schema } = compiled;

  // 每个被引用字段的候选值：已知值固定，否则取全部单元代表值。
  const domains: (boolean | number)[][] = plans.map((plan) => {
    const known = snapshot[plan.field];
    return known === undefined ? [...plan.representatives] : [known];
  });

  let passWitness: Completion | undefined;
  let failWitness: Completion | undefined;

  const current: (boolean | number)[] = new Array(plans.length);
  const visit = (index: number): boolean => {
    if (index === plans.length) {
      const assignment: Completion = {};
      for (let i = 0; i < plans.length; i++) {
        assignment[plans[i].field] = current[i];
      }
      if (evalExpr(applicable, assignment)) {
        if (evalExpr(required, assignment)) {
          passWitness ??= assignment;
        } else {
          failWitness ??= assignment;
        }
      }
      return passWitness !== undefined && failWitness !== undefined;
    }
    for (const value of domains[index]) {
      current[index] = value;
      if (visit(index + 1)) return true;
    }
    return false;
  };
  visit(0);

  // 补全为“完整补全”：未被引用的未知字段任取域内值（不影响表达式真值）。
  const complete = (partial: Completion): Completion => {
    const full: Completion = { ...partial };
    for (const [field, decl] of Object.entries(schema)) {
      if (full[field] === undefined) {
        full[field] =
          snapshot[field] ?? (decl.type === "boolean" ? false : decl.min);
      }
    }
    return full;
  };

  if (passWitness !== undefined && failWitness !== undefined) {
    return {
      conclusion: "Warning",
      passWitness: complete(passWitness),
      failWitness: complete(failWitness),
    };
  }
  if (passWitness !== undefined) {
    return { conclusion: "Pass", witness: complete(passWitness) };
  }
  if (failWitness !== undefined) {
    return { conclusion: "Fail", witness: complete(failWitness) };
  }
  return { conclusion: "NA" };
}
