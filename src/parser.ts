import { tokenize, SyntaxError, type Token } from "./lexer.js";
import type { BoolExpr, Program, Statement } from "./types.js";

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly envKeys: string[],
  ) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private fail(message: string, token: Token = this.peek()): never {
    throw new SyntaxError(message, token.offset);
  }

  private expectPunct(text: string): Token {
    const t = this.peek();
    if (t.kind !== "punct" || t.text !== text) {
      this.fail(`expected '${text}' but found ${describe(t)}`, t);
    }
    return this.next();
  }

  private expectIdent(text: string): Token {
    const t = this.peek();
    if (t.kind !== "ident" || t.text !== text) {
      this.fail(`expected '${text}' but found ${describe(t)}`, t);
    }
    return this.next();
  }

  parseProgram(): Statement[] {
    const open = this.next();
    if (open.kind !== "openTag") this.fail("source must begin with <?php", open);
    const statements = this.parseStatements();
    const t = this.peek();
    if (t.kind !== "eof") this.fail(`unexpected ${describe(t)}`, t);
    return statements;
  }

  private parseStatements(): Statement[] {
    const out: Statement[] = [];
    for (;;) {
      const t = this.peek();
      if (t.kind === "eof" || (t.kind === "punct" && t.text === "}")) break;
      if (t.kind === "punct" && t.text === ";") {
        this.next(); // empty statement
        continue;
      }
      out.push(this.parseStatement());
    }
    return out;
  }

  private parseStatement(): Statement {
    const t = this.peek();
    if (t.kind === "ident" && t.text === "define") {
      return this.parseDefine();
    }
    if (t.kind === "ident" && t.text === "if") {
      return this.parseIf();
    }
    this.fail(
      `unsupported statement starting with ${describe(t)}; only define(...) and if {...} are allowed`,
      t,
    );
  }

  private parseDefine(): Statement {
    this.expectIdent("define");
    this.expectPunct("(");
    const name = this.parseStringConcat();
    this.expectPunct(",");
    const value = this.parseBoolExpr();
    this.expectPunct(")");
    this.expectPunct(";");
    return { kind: "define", name, value };
  }

  private parseIf(): Statement {
    this.expectIdent("if");
    this.expectPunct("(");
    const cond = this.parseBoolExpr();
    this.expectPunct(")");
    this.expectPunct("{");
    const thenBranch = this.parseStatements();
    this.expectPunct("}");
    let elseBranch: Statement[] | null = null;
    const t = this.peek();
    if (t.kind === "ident" && t.text === "else") {
      this.next();
      this.expectPunct("{");
      elseBranch = this.parseStatements();
      this.expectPunct("}");
    }
    return { kind: "if", cond, then: thenBranch, else: elseBranch };
  }

  /** PHP single-quoted string literal with optional '.' concatenation. */
  private parseStringConcat(): string {
    let value = this.parseStringLiteral();
    while (this.peek().kind === "punct" && this.peek().text === ".") {
      this.next();
      value += this.parseStringLiteral();
    }
    return value;
  }

  private parseStringLiteral(): string {
    const t = this.peek();
    if (t.kind !== "string") {
      this.fail(`expected a single-quoted string but found ${describe(t)}`, t);
    }
    return this.next().text;
  }

  private parseBoolExpr(): BoolExpr {
    return this.parseOr();
  }

  private parseOr(): BoolExpr {
    let left = this.parseAnd();
    while (this.peek().kind === "op" && this.peek().text === "||") {
      this.next();
      left = { kind: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): BoolExpr {
    let left = this.parseUnary();
    while (this.peek().kind === "op" && this.peek().text === "&&") {
      this.next();
      left = { kind: "and", left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): BoolExpr {
    const t = this.peek();
    if (t.kind === "op" && t.text === "!") {
      this.next();
      return { kind: "not", operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): BoolExpr {
    const t = this.peek();
    if (t.kind === "ident" && t.text === "true") {
      this.next();
      return { kind: "const", value: true };
    }
    if (t.kind === "ident" && t.text === "false") {
      this.next();
      return { kind: "const", value: false };
    }
    if (t.kind === "punct" && t.text === "(") {
      this.next();
      const inner = this.parseBoolExpr();
      this.expectPunct(")");
      return inner;
    }
    if (t.kind === "ident" && t.text === "defined") {
      this.next();
      this.expectPunct("(");
      const name = this.parseStringConcat();
      this.expectPunct(")");
      return { kind: "defined", name };
    }
    if (t.kind === "ident" && t.text === "getenv") {
      return this.parseEnvCheck();
    }
    this.fail(`unsupported expression starting with ${describe(t)}`, t);
  }

  /** Only the exact form getenv('KEY') === '1' is supported. */
  private parseEnvCheck(): BoolExpr {
    this.expectIdent("getenv");
    this.expectPunct("(");
    const key = this.parseStringConcat();
    this.expectPunct(")");
    const op = this.peek();
    if (op.kind !== "op" || op.text !== "===") {
      this.fail("getenv(...) must be compared with === to the string '1'", op);
    }
    this.next();
    const rhs = this.peek();
    if (rhs.kind !== "string" || rhs.text !== "1") {
      this.fail("getenv(...) must be compared with === to the string '1'", rhs);
    }
    this.next();
    if (!this.envKeys.includes(key)) this.envKeys.push(key);
    return { kind: "env", key };
  }
}

function describe(t: Token): string {
  if (t.kind === "eof") return "end of input";
  return `'${t.text}'`;
}

export function parse(source: string): Program {
  const envKeys: string[] = [];
  const parser = new Parser(tokenize(source), envKeys);
  const statements = parser.parseProgram();
  return { statements, envKeys };
}
