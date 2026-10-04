import type { Expr, Policy, Schema } from "./types.js";

/** 编译后的可复用策略：保存 schema 与表达式，并预计算每个表达式引用的字段。 */
export interface CompiledPolicy {
  schema: Schema;
  applicable: Expr;
  required: Expr;
  /** applicable 中引用的字段（去重）。 */
  applicableFields: string[];
  /** required 中引用的字段（去重）。 */
  requiredFields: string[];
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

function checkExpr(schema: Schema, expr: Expr, path: string): void {
  switch (expr.op) {
    case "const":
      if (typeof expr.value !== "boolean") {
        throw new TypeError(`${path}: const value must be boolean`);
      }
      return;
    case "and":
    case "or":
      expr.args.forEach((arg, i) => checkExpr(schema, arg, `${path}.${expr.op}[${i}]`));
      return;
    case "not":
      checkExpr(schema, expr.arg, `${path}.not`);
      return;
    case "eq": {
      const type = schema.fields[expr.field];
      if (!type) throw new TypeError(`${path}: unknown field "${expr.field}"`);
      if (type.kind === "bool" && typeof expr.value !== "boolean") {
        throw new TypeError(`${path}: field "${expr.field}" is bool, eq value must be boolean`);
      }
      if (type.kind === "int" && typeof expr.value !== "number") {
        throw new TypeError(`${path}: field "${expr.field}" is int, eq value must be number`);
      }
      return;
    }
    case "lt": {
      const type = schema.fields[expr.field];
      if (!type) throw new TypeError(`${path}: unknown field "${expr.field}"`);
      if (type.kind !== "int") {
        throw new TypeError(`${path}: lt requires int field, "${expr.field}" is bool`);
      }
      if (typeof expr.value !== "number") {
        throw new TypeError(`${path}: lt value must be number`);
      }
      return;
    }
  }
}

export function compile(schema: Schema, policy: Policy): CompiledPolicy {
  checkExpr(schema, policy.applicable, "applicable");
  checkExpr(schema, policy.required, "required");
  const applicableFields = new Set<string>();
  const requiredFields = new Set<string>();
  collectFields(policy.applicable, applicableFields);
  collectFields(policy.required, requiredFields);
  return {
    schema,
    applicable: policy.applicable,
    required: policy.required,
    applicableFields: [...applicableFields],
    requiredFields: [...requiredFields],
  };
}
