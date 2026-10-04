export type TokenKind =
  | "openTag"
  | "ident"
  | "string"
  | "punct"
  | "op"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** Decoded value for strings; raw text otherwise. */
  text: string;
  offset: number;
}

export class SyntaxError extends Error {
  constructor(
    message: string,
    public readonly offset: number,
  ) {
    super(message);
    this.name = "SyntaxError";
  }
}

const PUNCT = new Set(["(", ")", "{", "}", ";", ",", "."]);
const OPS = ["===", "&&", "||", "!"];

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  const fail = (message: string, offset: number): never => {
    throw new SyntaxError(message, offset);
  };

  if (!source.startsWith("<?php")) {
    fail("source must begin with the PHP open tag <?php", 0);
  }
  const after = source[5];
  if (after !== undefined && !/\s/.test(after)) {
    fail("the <?php open tag must be followed by whitespace", 5);
  }
  tokens.push({ kind: "openTag", text: "<?php", offset: 0 });
  pos = 5;

  while (pos < source.length) {
    const ch = source[pos]!;

    // Whitespace
    if (/\s/.test(ch)) {
      pos++;
      continue;
    }

    // Line comments: // and #
    if (ch === "#" || (ch === "/" && source[pos + 1] === "/")) {
      const nl = source.indexOf("\n", pos);
      pos = nl === -1 ? source.length : nl + 1;
      continue;
    }

    // Block comments
    if (ch === "/" && source[pos + 1] === "*") {
      const end = source.indexOf("*/", pos + 2);
      if (end === -1) fail("unterminated block comment", pos);
      pos = end + 2;
      continue;
    }

    // Single-quoted string with PHP escapes \\ and \'
    if (ch === "'") {
      const start = pos;
      pos++;
      let value = "";
      for (;;) {
        if (pos >= source.length) fail("unterminated string literal", start);
        const c = source[pos]!;
        if (c === "\\") {
          const next = source[pos + 1];
          if (next === "\\" || next === "'") {
            value += next;
            pos += 2;
          } else {
            // In PHP single-quoted strings any other backslash is literal.
            value += "\\";
            pos++;
          }
          continue;
        }
        if (c === "'") {
          pos++;
          break;
        }
        value += c;
        pos++;
      }
      tokens.push({ kind: "string", text: value, offset: start });
      continue;
    }

    // Operators (longest first)
    const op = OPS.find((o) => source.startsWith(o, pos));
    if (op !== undefined) {
      tokens.push({ kind: "op", text: op, offset: pos });
      pos += op.length;
      continue;
    }

    // Punctuation
    if (PUNCT.has(ch)) {
      tokens.push({ kind: "punct", text: ch, offset: pos });
      pos++;
      continue;
    }

    // Identifiers / keywords
    if (isIdentStart(ch)) {
      const start = pos;
      while (pos < source.length && isIdentPart(source[pos]!)) pos++;
      tokens.push({ kind: "ident", text: source.slice(start, pos), offset: start });
      continue;
    }

    // Closing tag and everything else is outside the supported subset.
    if (source.startsWith("?>", pos)) {
      fail("PHP closing tag ?> is not supported", pos);
    }
    fail(`unsupported character or syntax ${JSON.stringify(ch)}`, pos);
  }

  tokens.push({ kind: "eof", text: "", offset: source.length });
  return tokens;
}
