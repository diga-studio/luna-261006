import type { Expr } from "./expr.js";
import type { Schema } from "./schema.js";

/** policy 输入：applicable 与 required 两个表达式。 */
export interface Policy {
  applicable: Expr;
  required: Expr;
}

/**
 * 单个未知字段的候选代表值。
 *
 * 关键观察：表达式对某字段的原子引用（eq / lt 常量）把该字段的域
 * 划分为若干“单元”，同一单元内所有值对每个原子的真值完全相同，
 * 因此每个单元只需考察一个代表值即可精确覆盖所有合法补全。
 */
export interface FieldPlan {
  field: string;
  /** 每个单元一个代表值；boolean 域为 [false, true]。 */
  representatives: (boolean | number)[];
}

/** 编译后的可复用策略（含预计算的字段划分）。 */
export interface CompiledPolicy {
  readonly schema: Schema;
  readonly applicable: Expr;
  readonly required: Expr;
  /** 被 applicable / required 引用到的字段及其代表值，按字段名排序。 */
  readonly plans: readonly FieldPlan[];
}

/** 收集表达式中引用到的 (字段, 原子常量)。 */
function collectAtoms(
  expr: Expr,
  eqConsts: Map<string, (boolean | number)[]>,
  ltConsts: Map<string, number[]>,
): void {
  switch (expr.kind) {
    case "const":
      return;
    case "and":
    case "or":
      for (const arg of expr.args) collectAtoms(arg, eqConsts, ltConsts);
      return;
    case "not":
      collectAtoms(expr.arg, eqConsts, ltConsts);
      return;
    case "eq": {
      const list = eqConsts.get(expr.field) ?? [];
      list.push(expr.value);
      eqConsts.set(expr.field, list);
      return;
    }
    case "lt": {
      const list = ltConsts.get(expr.field) ?? [];
      list.push(expr.value);
      ltConsts.set(expr.field, list);
      return;
    }
  }
}

/** 整数字段：由原子常量把 [min, max] 划分为单元，返回每个单元的代表值。 */
function integerRepresentatives(
  min: number,
  max: number,
  eqConsts: number[],
  ltConsts: number[],
): number[] {
  const eqPoints = new Set(eqConsts.filter((c) => c >= min && c <= max));
  const ltBounds = new Set(ltConsts.filter((c) => c > min && c <= max));
  const events = [...new Set([...eqPoints, ...ltBounds])].sort((a, b) => a - b);
  const reps: number[] = [];
  let start = min;
  for (const c of events) {
    if (start <= c - 1) reps.push(start); // 单元 [start, c-1]
    if (eqPoints.has(c)) {
      reps.push(c); // 单点单元 {c}
      start = c + 1;
    } else {
      start = c;
    }
  }
  if (start <= max) reps.push(start); // 单元 [start, max]
  return reps;
}

/**
 * 编译策略：收集原子引用，按字段把域划分为等价单元，
 * 生成可复用的判定计划。输入假设结构合法、常量类型与字段匹配。
 */
export function compile(schema: Schema, policy: Policy): CompiledPolicy {
  const eqConsts = new Map<string, (boolean | number)[]>();
  const ltConsts = new Map<string, number[]>();
  collectAtoms(policy.applicable, eqConsts, ltConsts);
  collectAtoms(policy.required, eqConsts, ltConsts);

  const fieldNames = [...new Set([...eqConsts.keys(), ...ltConsts.keys()])].sort();
  const plans: FieldPlan[] = fieldNames.map((field) => {
    const decl = schema[field];
    if (decl === undefined) {
      throw new Error(`policy references unknown field: ${field}`);
    }
    if (decl.type === "boolean") {
      if ((ltConsts.get(field) ?? []).length > 0) {
        throw new Error(`lt is not supported on boolean field: ${field}`);
      }
      return { field, representatives: [false, true] };
    }
    const eqs = (eqConsts.get(field) ?? []) as number[];
    const lts = ltConsts.get(field) ?? [];
    return {
      field,
      representatives: integerRepresentatives(decl.min, decl.max, eqs, lts),
    };
  });

  return {
    schema,
    applicable: policy.applicable,
    required: policy.required,
    plans,
  };
}
