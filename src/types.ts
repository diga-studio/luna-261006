/** Boolean expression AST for the restricted PHP subset. */
export type BoolExpr =
  | { kind: 'const'; value: boolean }
  | { kind: 'not'; operand: BoolExpr }
  | { kind: 'and'; left: BoolExpr; right: BoolExpr }
  | { kind: 'or'; left: BoolExpr; right: BoolExpr }
  | { kind: 'defined'; name: string }
  | { kind: 'env'; key: string };

export type Stmt =
  | { kind: 'define'; name: string; value: BoolExpr }
  | { kind: 'if'; cond: BoolExpr; then: Stmt[]; else: Stmt[] | null };

export interface Program {
  stmts: Stmt[];
}

/** Names of the two target constants checked for compliance. */
export const TARGET_CONSTANTS = ['DISALLOW_FILE_EDIT', 'FORCE_SSL_ADMIN'] as const;

/** Error thrown for any input outside the supported subset. */
export class SubsetError extends Error {
  constructor(message: string, public readonly offset?: number) {
    super(message);
    this.name = 'SubsetError';
  }
}
