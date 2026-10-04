import { parse } from './parser.js';
import { SubsetError, TARGET_CONSTANTS, type BoolExpr, type Program, type Stmt } from './types.js';

export interface EvalResult {
  values: {
    DISALLOW_FILE_EDIT: boolean | undefined;
    FORCE_SSL_ADMIN: boolean | undefined;
  };
  compliant: boolean;
}

function evalBool(e: BoolExpr, defined: ReadonlyMap<string, boolean>, env: Record<string, boolean>): boolean {
  switch (e.kind) {
    case 'const':
      return e.value;
    case 'not':
      return !evalBool(e.operand, defined, env);
    case 'and':
      return evalBool(e.left, defined, env) && evalBool(e.right, defined, env);
    case 'or':
      return evalBool(e.left, defined, env) || evalBool(e.right, defined, env);
    case 'defined':
      return defined.has(e.name);
    case 'env': {
      const v = env[e.key];
      if (typeof v !== 'boolean') {
        throw new SubsetError(`env is missing a boolean value for key '${e.key}'`);
      }
      return v;
    }
  }
}

/** Concrete execution of the restricted semantics under one full env assignment. */
export function runProgram(program: Program, env: Record<string, boolean>): Map<string, boolean> {
  const defined = new Map<string, boolean>();
  // Explicit stack so deeply nested ifs cannot overflow the call stack.
  const stack: Array<{ stmts: readonly Stmt[]; i: number }> = [{ stmts: program.stmts, i: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.i >= top.stmts.length) {
      stack.pop();
      continue;
    }
    const stmt = top.stmts[top.i++]!;
    if (stmt.kind === 'define') {
      if (!defined.has(stmt.name)) {
        defined.set(stmt.name, evalBool(stmt.value, defined, env));
      }
      continue;
    }
    const cond = evalBool(stmt.cond, defined, env);
    const branch = cond ? stmt.then : stmt.else;
    if (branch !== null && branch.length > 0) {
      stack.push({ stmts: branch, i: 0 });
    }
  }
  return defined;
}

export function evaluate(source: string, env: Record<string, boolean>): EvalResult {
  const defined = runProgram(parse(source), env);
  const dfe = defined.get('DISALLOW_FILE_EDIT');
  const fsa = defined.get('FORCE_SSL_ADMIN');
  const values = {
    DISALLOW_FILE_EDIT: dfe as boolean | undefined,
    FORCE_SSL_ADMIN: fsa as boolean | undefined,
  };
  return {
    values,
    compliant: dfe === true && fsa === true,
  };
}

export { TARGET_CONSTANTS };
