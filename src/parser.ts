import { tokenize, type Token, type TokenType } from './lexer.js';
import { SubsetError, type BoolExpr, type Program, type Stmt } from './types.js';

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expect(type: TokenType, what: string): Token {
    const tok = this.peek();
    if (tok.type !== type) {
      throw new SubsetError(`expected ${what}, found '${tok.type}'`, tok.offset);
    }
    return this.next();
  }

  parseProgram(): Program {
    const stmts: Stmt[] = [];
    while (this.peek().type !== 'eof') {
      const stmt = this.parseStmt();
      if (stmt !== null) stmts.push(stmt);
    }
    return { stmts };
  }

  /** Returns null for empty statements. */
  private parseStmt(): Stmt | null {
    const tok = this.peek();
    if (tok.type === 'semi') {
      this.next();
      return null;
    }
    if (tok.type === 'define') return this.parseDefine();
    if (tok.type === 'if') return this.parseIf();
    throw new SubsetError(
      `unsupported statement starting with '${tok.type}' (only define/if/; are supported)`,
      tok.offset,
    );
  }

  private parseDefine(): Stmt {
    this.expect('define', "'define'");
    this.expect('lparen', "'('");
    const name = this.parseStringExpr();
    this.expect('comma', "','");
    const value = this.parseBoolExpr();
    this.expect('rparen', "')'");
    this.expect('semi', "';'");
    return { kind: 'define', name, value };
  }

  private parseIf(): Stmt {
    this.expect('if', "'if'");
    this.expect('lparen', "'('");
    const cond = this.parseBoolExpr();
    this.expect('rparen', "')'");
    const then = this.parseBlock();
    let elseStmts: Stmt[] | null = null;
    if (this.peek().type === 'else') {
      this.next();
      elseStmts = this.parseBlock();
    }
    return { kind: 'if', cond, then, else: elseStmts };
  }

  private parseBlock(): Stmt[] {
    this.expect('lbrace', "'{' (braces are required around branches)");
    const stmts: Stmt[] = [];
    while (this.peek().type !== 'rbrace') {
      if (this.peek().type === 'eof') {
        throw new SubsetError('unterminated block', this.peek().offset);
      }
      const stmt = this.parseStmt();
      if (stmt !== null) stmts.push(stmt);
    }
    this.next();
    return stmts;
  }

  /** Single-quoted string literals joined by the `.` operator. */
  private parseStringExpr(): string {
    let result = this.expect('string', 'a single-quoted string').value!;
    while (this.peek().type === 'dot') {
      this.next();
      result += this.expect('string', 'a single-quoted string after .').value!;
    }
    return result;
  }

  parseBoolExpr(): BoolExpr {
    return this.parseOr();
  }

  private parseOr(): BoolExpr {
    let left = this.parseAnd();
    while (this.peek().type === 'or') {
      this.next();
      left = { kind: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): BoolExpr {
    let left = this.parseNot();
    while (this.peek().type === 'and') {
      this.next();
      left = { kind: 'and', left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): BoolExpr {
    if (this.peek().type === 'not') {
      this.next();
      return { kind: 'not', operand: this.parseNot() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): BoolExpr {
    const tok = this.peek();
    switch (tok.type) {
      case 'true':
        this.next();
        return { kind: 'const', value: true };
      case 'false':
        this.next();
        return { kind: 'const', value: false };
      case 'lparen': {
        this.next();
        const inner = this.parseBoolExpr();
        this.expect('rparen', "')'");
        return inner;
      }
      case 'defined': {
        this.next();
        this.expect('lparen', "'('");
        const name = this.parseStringExpr();
        this.expect('rparen', "')'");
        return { kind: 'defined', name };
      }
      case 'getenv':
        return this.parseEnvCheck();
      default:
        throw new SubsetError(
          `unsupported expression starting with '${tok.type}'`,
          tok.offset,
        );
    }
  }

  /** Parses `getenv(<stringExpr>) === '1'` as a single environment atom. */
  private parseEnvCheck(): BoolExpr {
    this.expect('getenv', "'getenv'");
    this.expect('lparen', "'('");
    const key = this.parseStringExpr();
    this.expect('rparen', "')'");
    this.expect('eq', "'==='");
    const rhs = this.expect('string', "the string '1'").value!;
    if (rhs !== '1') {
      throw new SubsetError(
        `only getenv('KEY') === '1' environment checks are supported, got === '${rhs}'`,
        this.peek().offset,
      );
    }
    return { kind: 'env', key };
  }
}

export function parse(source: string): Program {
  return new Parser(tokenize(source)).parseProgram();
}
