/**
 * 类型定义：schema / 表达式 / 策略 / 快照 / 求值结果。
 *
 * 表达式 JSON 语法树布局（Expr）：
 *   { "op": "const", "value": boolean }
 *   { "op": "and",   "args": Expr[] }
 *   { "op": "or",    "args": Expr[] }
 *   { "op": "not",   "arg": Expr }
 *   { "op": "eq",    "field": string, "value": boolean | number }  // 字段与同类型常量比较
 *   { "op": "lt",    "field": string, "value": number }            // 仅整数字段
 */

export type FieldType =
  | { kind: "bool" }
  | { kind: "int"; min: number; max: number };

export interface Schema {
  fields: Record<string, FieldType>;
}

export type Expr =
  | { op: "const"; value: boolean }
  | { op: "and"; args: Expr[] }
  | { op: "or"; args: Expr[] }
  | { op: "not"; arg: Expr }
  | { op: "eq"; field: string; value: boolean | number }
  | { op: "lt"; field: string; value: number };

export interface Policy {
  applicable: Expr;
  required: Expr;
}

export type FieldValue = boolean | number;

/** 字段到已知值的部分映射；未出现的字段为未知。 */
export type Snapshot = Record<string, FieldValue>;

/** 完整补全：所有字段都有值。 */
export type Assignment = Record<string, FieldValue>;

export type Conclusion = "NA" | "Pass" | "Fail" | "Warning";

export interface Witnesses {
  /** Pass/Warning 时存在：applicable 与 required 均为真的完整补全。 */
  pass?: Assignment;
  /** Fail/Warning 时存在：applicable 为真、required 为假的完整补全。 */
  fail?: Assignment;
}

export interface EvalResult {
  conclusion: Conclusion;
  witnesses: Witnesses;
}
