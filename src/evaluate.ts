import type { CompiledPolicy } from "./compile.js";
import { solve } from "./solver.js";
import type { EvalResult, Expr, Snapshot } from "./types.js";

/**
 * 精确判定：
 *   适用补全 = 保留 snapshot 且使 applicable 为真的完整补全。
 *   NA      无适用补全
 *   Pass    有适用补全，且 required 在所有适用补全中为真（即不存在 applicable∧¬required 的补全）
 *   Fail    有适用补全，且 required 在所有适用补全中为假（即不存在 applicable∧required 的补全）
 *   Warning 两类补全都存在
 */
export function evaluate(compiled: CompiledPolicy, snapshot: Snapshot): EvalResult {
  const { schema, applicable, required } = compiled;

  const appOnly = solve(schema, [applicable], snapshot);
  if (appOnly === null) {
    return { conclusion: "NA", witnesses: {} };
  }

  const notRequired: Expr = { op: "not", arg: required };
  const appReqTrue = solve(schema, [applicable, required], snapshot);
  const appReqFalse = solve(schema, [applicable, notRequired], snapshot);

  if (appReqTrue !== null && appReqFalse !== null) {
    return { conclusion: "Warning", witnesses: { pass: appReqTrue, fail: appReqFalse } };
  }
  if (appReqTrue !== null) {
    return { conclusion: "Pass", witnesses: { pass: appReqTrue } };
  }
  // 存在适用补全且 required 恒假时，appReqFalse 必然可解。
  return { conclusion: "Fail", witnesses: { fail: appReqFalse! } };
}
