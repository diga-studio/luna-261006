import type { Assignment, Expr, FieldType, FieldValue, Schema } from "./types.js";

/** 三态值：true / false / unknown（undefined）。 */
export type Tri = boolean | undefined;

/**
 * 普通布尔求值（完整补全上使用），用于独立核验见证。
 * 假设 assignment 覆盖表达式引用的所有字段。
 */
export function evalBool(expr: Expr, assignment: Assignment): boolean {
  switch (expr.op) {
    case "const":
      return expr.value;
    case "and":
      return expr.args.every((a) => evalBool(a, assignment));
    case "or":
      return expr.args.some((a) => evalBool(a, assignment));
    case "not":
      return !evalBool(expr.arg, assignment);
    case "eq":
      return assignment[expr.field] === expr.value;
    case "lt":
      return (assignment[expr.field] as number) < expr.value;
  }
}

/** 三态求值：缺失字段（不在 assignment 中）使相关原子表达式为 unknown。 */
export function evalTri(expr: Expr, assignment: Assignment): Tri {
  switch (expr.op) {
    case "const":
      return expr.value;
    case "and": {
      let unknown = false;
      for (const arg of expr.args) {
        const v = evalTri(arg, assignment);
        if (v === false) return false;
        if (v === undefined) unknown = true;
      }
      return unknown ? undefined : true;
    }
    case "or": {
      let unknown = false;
      for (const arg of expr.args) {
        const v = evalTri(arg, assignment);
        if (v === true) return true;
        if (v === undefined) unknown = true;
      }
      return unknown ? undefined : false;
    }
    case "not": {
      const v = evalTri(expr.arg, assignment);
      return v === undefined ? undefined : !v;
    }
    case "eq": {
      const v = assignment[expr.field];
      return v === undefined ? undefined : v === expr.value;
    }
    case "lt": {
      const v = assignment[expr.field];
      return v === undefined ? undefined : (v as number) < expr.value;
    }
  }
}

/** 字段域内的全部取值（bool 先 false 后 true，int 升序）。 */
export function domainValues(type: FieldType): FieldValue[] {
  if (type.kind === "bool") return [false, true];
  const values: number[] = [];
  for (let i = type.min; i <= type.max; i++) values.push(i);
  return values;
}

function collectFields(expr: Expr, into: Set<string>): void {
  switch (expr.op) {
    case "const":
      return;
    case "and":
    case "or":
      for (const arg of expr.args) collectFields(arg, into);
      return;
    case "not":
      collectFields(expr.arg, into);
      return;
    case "eq":
    case "lt":
      into.add(expr.field);
      return;
  }
}

/**
 * DPLL 风格求解：寻找使所有 exprs 同时为真的补全。
 * base 为已知赋值（snapshot），求解过程中不修改它。
 * 找到后返回覆盖 schema 全部字段的完整补全；无解返回 null。
 */
export function solve(schema: Schema, exprs: Expr[], base: Assignment): Assignment | null {
  const assignment: Assignment = { ...base };
  const referenced = new Set<string>();
  for (const e of exprs) collectFields(e, referenced);

  function search(): boolean {
    let allTrue = true;
    for (const e of exprs) {
      const v = evalTri(e, assignment);
      if (v === false) return false;
      if (v === undefined) allTrue = false;
    }
    if (allTrue) return true;
    // 选择一个未赋值但被引用的字段分支。
    let branchField: string | undefined;
    for (const f of referenced) {
      if (assignment[f] === undefined) {
        branchField = f;
        break;
      }
    }
    if (branchField === undefined) return false; // 引用字段都已赋值但仍非全真，不可能发生，防御。
    for (const value of domainValues(schema.fields[branchField])) {
      assignment[branchField] = value;
      if (search()) return true;
    }
    delete assignment[branchField];
    return false;
  }

  if (!search()) return null;
  // 未被赋值的字段（表达式未引用或搜索未触及）补为域内任意值，构成完整补全。
  for (const [field, type] of Object.entries(schema.fields)) {
    if (assignment[field] === undefined) {
      assignment[field] = domainValues(type)[0];
    }
  }
  return assignment;
}
