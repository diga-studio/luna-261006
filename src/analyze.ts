import { BddManager, type Bdd } from "./bdd.js";
import { parse } from "./parser.js";
import type {
  AnalysisResult,
  BoolExpr,
  Statement,
  Witness,
} from "./types.js";

interface SymbolicConstant {
  defined: Bdd;
  /** Correct wherever `defined` holds; meaningless elsewhere. */
  value: Bdd;
}

class SymbolicInterpreter {
  private readonly constants = new Map<string, SymbolicConstant>();

  constructor(private readonly mgr: BddManager) {}

  run(statements: Statement[], pc: Bdd): void {
    for (const stmt of statements) this.exec(stmt, pc);
  }

  private exec(stmt: Statement, pc: Bdd): void {
    const mgr = this.mgr;
    if (pc === mgr.FALSE) return;
    if (stmt.kind === "define") {
      const expr = this.evalBool(stmt.value, pc);
      const existing = this.constants.get(stmt.name);
      if (existing === undefined) {
        this.constants.set(stmt.name, {
          defined: pc,
          value: mgr.and(pc, expr),
        });
      } else {
        // First define wins: keep the old value where already defined.
        const newlyDefined = mgr.and(pc, mgr.not(existing.defined));
        this.constants.set(stmt.name, {
          defined: mgr.or(existing.defined, pc),
          value: mgr.or(
            mgr.and(existing.defined, existing.value),
            mgr.and(newlyDefined, expr),
          ),
        });
      }
      return;
    }
    const cond = this.evalBool(stmt.cond, pc);
    this.run(stmt.then, mgr.and(pc, cond));
    if (stmt.else !== null) {
      this.run(stmt.else, mgr.and(pc, mgr.not(cond)));
    }
  }

  private evalBool(expr: BoolExpr, pc: Bdd): Bdd {
    const mgr = this.mgr;
    switch (expr.kind) {
      case "const":
        return expr.value ? mgr.TRUE : mgr.FALSE;
      case "not":
        return mgr.not(this.evalBool(expr.operand, pc));
      case "and": {
        const left = this.evalBool(expr.left, pc);
        if (left === mgr.FALSE) return mgr.FALSE;
        return mgr.and(left, this.evalBool(expr.right, pc));
      }
      case "or": {
        const left = this.evalBool(expr.left, pc);
        if (left === mgr.TRUE) return mgr.TRUE;
        return mgr.or(left, this.evalBool(expr.right, pc));
      }
      case "defined":
        return this.constants.get(expr.name)?.defined ?? mgr.FALSE;
      case "env":
        return mgr.variable(expr.key);
    }
  }

  state(name: string): SymbolicConstant {
    const mgr = this.mgr;
    return (
      this.constants.get(name) ?? { defined: mgr.FALSE, value: mgr.FALSE }
    );
  }
}

export function analyze(source: string): AnalysisResult {
  const program = parse(source);
  const mgr = new BddManager();
  const interpreter = new SymbolicInterpreter(mgr);
  interpreter.run(program.statements, mgr.TRUE);

  let compliant = mgr.TRUE;
  for (const name of ["DISALLOW_FILE_EDIT", "FORCE_SSL_ADMIN"] as const) {
    const state = interpreter.state(name);
    compliant = mgr.and(compliant, mgr.and(state.defined, state.value));
  }

  const toWitness = (assignment: Map<number, boolean>): Witness => {
    const env: Record<string, boolean> = {};
    for (const key of program.envKeys) env[key] = false;
    for (const [index, value] of assignment) {
      env[mgr.varName(index)] = value;
    }
    return { env };
  };

  if (compliant === mgr.TRUE) {
    return { verdict: "PASS", compliantWitness: toWitness(new Map()) };
  }
  if (compliant === mgr.FALSE) {
    const bad = mgr.satisfy(mgr.TRUE);
    return {
      verdict: "FAIL",
      nonCompliantWitness: toWitness(bad ?? new Map()),
    };
  }
  const good = mgr.satisfy(compliant);
  const bad = mgr.satisfy(mgr.not(compliant));
  const result: AnalysisResult = { verdict: "CONDITIONAL" };
  if (good !== null) result.compliantWitness = toWitness(good);
  if (bad !== null) result.nonCompliantWitness = toWitness(bad);
  return result;
}
