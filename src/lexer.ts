import { SubsetError } from './types.js';

export type TokenType =
  | 'lbrace' | 'rbrace' | 'lparen' | 'rparen' | 'semi' | 'comma' | 'dot'
  | 'not' | 'and' | 'or' | 'eq'
  | 'true' | 'false' | 'if' | 'else' | 'define' | 'defined' | 'getenv'
  | 'string' | 'eof';

export interface Token {
  type: TokenType;
  /** Decoded value for `string` tokens. */
  value?: string;
  offset: number;
}

const KEYWORDS: Record<string, TokenType> = {
  true: 'true',
  false: 'false',
  if: 'if',
  else: 'else',
  define: 'define',
  defined: 'defined',
  getenv: 'getenv',
};

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/** Strips the leading `<?php` open tag; returns offset of first token. */
function consumeOpenTag(source: string): number {
  let i = 0;
  if (source.charCodeAt(0) === 0xfeff) i = 1; // optional BOM
  if (!source.startsWith('<?php', i)) {
    throw new SubsetError('input must start with the <?php open tag', i);
  }
  i += '<?php'.length;
  const next = source[i];
  if (next !== undefined && !/\s/.test(next) && next !== '/' && next !== '#') {
    throw new SubsetError('expected whitespace after <?php', i);
  }
  return i;
}

function readString(source: string, start: number): { value: string; end: number } {
  // PHP single-quoted string: only \\ and \' are escape sequences.
  let value = '';
  let i = start + 1;
  for (;;) {
    if (i >= source.length) {
      throw new SubsetError('unterminated string literal', start);
    }
    const ch = source[i]!;
    if (ch === "'") return { value, end: i + 1 };
    if (ch === '\\') {
      const next = source[i + 1];
      if (next === '\\' || next === "'") {
        value += next;
        i += 2;
        continue;
      }
      value += '\\';
      i += 1;
      continue;
    }
    value += ch;
    i += 1;
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = consumeOpenTag(source);
  const n = source.length;

  while (i < n) {
    const ch = source[i]!;
    if (/\s/.test(ch)) { i += 1; continue; }

    // Comments: //, #, /* ... */
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === '#') {
      const nl = source.indexOf('\n', i + 1);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) throw new SubsetError('unterminated block comment', i);
      i = close + 2;
      continue;
    }

    if (ch === "'") {
      const { value, end } = readString(source, i);
      tokens.push({ type: 'string', value, offset: i });
      i = end;
      continue;
    }

    if (ch === '&' && source[i + 1] === '&') {
      tokens.push({ type: 'and', offset: i }); i += 2; continue;
    }
    if (ch === '|' && source[i + 1] === '|') {
      tokens.push({ type: 'or', offset: i }); i += 2; continue;
    }
    if (ch === '=' && source[i + 1] === '=' && source[i + 2] === '=') {
      tokens.push({ type: 'eq', offset: i }); i += 3; continue;
    }
    if (ch === '?' && source[i + 1] === '>') {
      throw new SubsetError('closing tag ?> is not supported', i);
    }

    const single: Record<string, TokenType> = {
      '{': 'lbrace', '}': 'rbrace', '(': 'lparen', ')': 'rparen',
      ';': 'semi', ',': 'comma', '.': 'dot', '!': 'not',
    };
    const simple = single[ch];
    if (simple !== undefined) {
      tokens.push({ type: simple, offset: i }); i += 1; continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && isIdentChar(source[j]!)) j += 1;
      const word = source.slice(i, j);
      const kw = KEYWORDS[word];
      if (kw === undefined) {
        throw new SubsetError(`unsupported identifier '${word}'`, i);
      }
      tokens.push({ type: kw, offset: i });
      i = j;
      continue;
    }

    throw new SubsetError(`unsupported character '${ch}'`, i);
  }

  tokens.push({ type: 'eof', offset: n });
  return tokens;
}
