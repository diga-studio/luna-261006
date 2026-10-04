import type { Formula, FormulaBuilder } from './formula.js';
import type { BoolExpr, Program, Stmt } from './types.js';

export interface ConstState {
  /** Condition under which the constant is defined. */
  def: Formula;
  /** Condition under which the constant's value is true. */
  val: Formula;
}

export interface SymbolicResult {
  constants: ReadonlyMap<string, ConstState>;
  /** All environment keys referenced by the program. */
  envKeys: readonly string[];
}

type State = Map<string, ConstState>;

/**
 * Symbolically executes the program over all environment assignments at
 * once. Each constant's definedness and value are tracked as formulas over
 * environment atoms; the DAG stays polynomial in program size (no path
 * enumeration, no environment enumeration).
 */
export function symbolicExecute(program: Program, b: FormulaBuilder): SymbolicResult {
  const envKeys = new Set<string>();
  const FALSE = b.const(false);

  const evalExpr = (e: BoolExpr, state: State): Formula => {
    switch (e.kind) {
      case 'const':
        return b.const(e.value);
      case 'not':
        return b.not(evalExpr(e.operand, state));
      case 'and':
        return b.and(evalExpr(e.left, state), evalExpr(e.right, state));
      case 'or':
        return b.or(evalExpr(e.left, state), evalExpr(e.right, state));
      case 'defined':
        return state.get(e.name)?.def ?? FALSE;
      case 'env':
        envKeys.add(e.key);
        return b.atom(e.key);
    }
  };

  const applyDefine = (state: State, pc: Formula, name: string, value: BoolExpr): void => {
    const cur = state.get(name) ?? { def: FALSE, val: FALSE };
    const val = evalExpr(value, state);
    // First define on a path wins: only where the constant is not yet
    // defined does this define take effect.
    const notDef = b.not(cur.def);
    const notPc = b.not(pc);
    state.set(name, {
      def: b.or(cur.def, pc),
      val: b.or(
        b.or(b.and(cur.def, cur.val), b.and(b.and(notDef, notPc), cur.val)),
        b.and(b.and(notDef, pc), val),
      ),
    });
  };

  const mergeInto = (target: State, cf: Formula, thenS: State, elseS: State): void => {
    const ncf = b.not(cf);
    const keys = new Set<string>([...thenS.keys(), ...elseS.keys()]);
    for (const key of keys) {
      const t = thenS.get(key) ?? { def: FALSE, val: FALSE };
      const e = elseS.get(key) ?? { def: FALSE, val: FALSE };
      target.set(key, {
        def: b.or(b.and(cf, t.def), b.and(ncf, e.def)),
        val: b.or(b.and(cf, t.val), b.and(ncf, e.val)),
      });
    }
  };

  // Explicit task stack: deeply nested ifs must not overflow the call stack.
  const tasks: Array<() => void> = [];
  const push = (task: () => void): void => {
    tasks.push(task);
  };

  const runList = (stmts: readonly Stmt[], pc: Formula, state: State, done: () => void): void => {
    let i = 0;
    const step = (): void => {
      while (i < stmts.length) {
        const stmt = stmts[i++]!;
        if (stmt.kind === 'define') {
          applyDefine(state, pc, stmt.name, stmt.value);
          continue;
        }
        const cf = evalExpr(stmt.cond, state);
        const thenState: State = new Map(state);
        const elseState: State = new Map(state);
        push(() =>
          runList(stmt.then, b.and(pc, cf), thenState, () => {
            const finishElse = (): void => {
              mergeInto(state, cf, thenState, elseState);
              push(step);
            };
            if (stmt.else !== null) {
              push(() => runList(stmt.else!, b.and(pc, b.not(cf)), elseState, finishElse));
            } else {
              finishElse();
            }
          }),
        );
        return; // resume via continuations
      }
      done();
    };
    push(step);
  };

  const root: State = new Map();
  runList(program.stmts, b.const(true), root, () => undefined);
  while (tasks.length > 0) {
    tasks.pop()!();
  }

  return { constants: root, envKeys: [...envKeys] };
}
