import type { Completion } from "./schema.js";

/**
 * 策略表达式的 JSON 语法树。
 *
 * 支持：
 * - const: 布尔常量
 * - and / or: 任意多个子表达式
 * - not: 单个子表达式
 * - eq: 字段与同类型常量比较（boolean 或 integer）
 * - lt: 整数字段与整数常量比较（field < value）
 *
 * 不支持字段互比；表达式可任意嵌套、重复引用同一字段。
 */
export type Expr =
  | { kind: "const"; value: boolean }
  | { kind: "and"; args: Expr[] }
  | { kind: "or"; args: Expr[] }
  | { kind: "not"; arg: Expr }
  | { kind: "eq"; field: string; value: boolean | number }
  | { kind: "lt"; field: string; value: number };

/**
 * 普通布尔求值：在完整补全（所有被引用字段都有值）上求表达式的真值。
 * 见证可调用本函数独立核验。
 */
export function evalExpr(expr: Expr, completion: Completion): boolean {
  switch (expr.kind) {
    case "const":
      return expr.value;
    case "and":
      return expr.args.every((arg) => evalExpr(arg, completion));
    case "or":
      return expr.args.some((arg) => evalExpr(arg, completion));
    case "not":
      return !evalExpr(expr.arg, completion);
    case "eq":
      return completion[expr.field] === expr.value;
    case "lt":
      return (completion[expr.field] as number) < expr.value;
  }
}
