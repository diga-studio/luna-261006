import { parse } from "./parser.js";
import type {
  BoolExpr,
  ConstantState,
  EvaluationResult,
  Statement,
} from "./types.js";

class ConcreteInterpreter {
  /** Defined constants: name -> value. Absence means not defined. */
  private readonly constants = new Map<string, boolean>();

  constructor(private readonly env: Readonly<Record<string, boolean>>) {}

  run(statements: Statement[]): void {
    for (const stmt of statements) this.exec(stmt);
  }

  private exec(stmt: Statement): void {
    if (stmt.kind === "define") {
      if (!this.constants.has(stmt.name)) {
        this.constants.set(stmt.name, this.evalBool(stmt.value));
      }
      return;
    }
    const branch = this.evalBool(stmt.cond) ? stmt.then : stmt.else;
    if (branch !== null) this.run(branch);
  }

  private evalBool(expr: BoolExpr): boolean {
    switch (expr.kind) {
      case "const":
        return expr.value;
      case "not":
        return !this.evalBool(expr.operand);
      case "and":
        return this.evalBool(expr.left) && this.evalBool(expr.right);
      case "or":
        return this.evalBool(expr.left) || this.evalBool(expr.right);
      case "defined":
        return this.constants.has(expr.name);
      case "env":
        return this.env[expr.key] === true;
    }
  }

  state(name: string): ConstantState {
    const value = this.constants.get(name);
    return value === undefined
      ? { defined: false, value: false }
      : { defined: true, value };
  }
}

export function evaluate(
  source: string,
  env: Readonly<Record<string, boolean>>,
): EvaluationResult {
  const program = parse(source);
  const interpreter = new ConcreteInterpreter(env);
  interpreter.run(program.statements);
  const disallowFileEdit = interpreter.state("DISALLOW_FILE_EDIT");
  const forceSslAdmin = interpreter.state("FORCE_SSL_ADMIN");
  return {
    constants: {
      DISALLOW_FILE_EDIT: disallowFileEdit,
      FORCE_SSL_ADMIN: forceSslAdmin,
    },
    compliant:
      disallowFileEdit.defined &&
      disallowFileEdit.value &&
      forceSslAdmin.defined &&
      forceSslAdmin.value,
  };
}
