/** AST and public result types for the wp-config compliance analyzer. */

export type BoolExpr =
  | { kind: "const"; value: boolean }
  | { kind: "not"; operand: BoolExpr }
  | { kind: "and"; left: BoolExpr; right: BoolExpr }
  | { kind: "or"; left: BoolExpr; right: BoolExpr }
  | { kind: "defined"; name: string }
  | { kind: "env"; key: string };

export type Statement =
  | { kind: "define"; name: string; value: BoolExpr }
  | { kind: "if"; cond: BoolExpr; then: Statement[]; else: Statement[] | null };

export interface Program {
  statements: Statement[];
  /** All environment keys referenced by getenv(...) === '1' checks, in first-use order. */
  envKeys: string[];
}

export const TARGET_CONSTANTS = ["DISALLOW_FILE_EDIT", "FORCE_SSL_ADMIN"] as const;

export interface Witness {
  /** Complete assignment for every env key referenced by the source. */
  env: Record<string, boolean>;
}

export type Verdict = "PASS" | "FAIL" | "CONDITIONAL";

export interface AnalysisResult {
  verdict: Verdict;
  /** Present when at least one environment assignment is compliant. */
  compliantWitness?: Witness;
  /** Present when at least one environment assignment is non-compliant. */
  nonCompliantWitness?: Witness;
}

export interface ConstantState {
  defined: boolean;
  /** Meaningful only when defined is true. */
  value: boolean;
}

export interface EvaluationResult {
  constants: {
    DISALLOW_FILE_EDIT: ConstantState;
    FORCE_SSL_ADMIN: ConstantState;
  };
  /** True iff both target constants are defined with value true. */
  compliant: boolean;
}
