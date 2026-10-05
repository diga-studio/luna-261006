/** Tokenizer / parser for the restricted content-stream grammar:
 *  q Q cm BT ET Tf Tm Td Tj TJ Do, literal & hex strings, TJ arrays. */

export type Operand =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'string'; bytes: number[] }
  | { kind: 'array'; items: Array<{ kind: 'number'; value: number } | { kind: 'string'; bytes: number[] }> };

export interface ContentOp {
  /** Operator name, e.g. 'Tj', 'cm', 'Do'. */
  name: string;
  operands: Operand[];
  /** Raw source slice covering operands + operator (for verbatim re-emission). */
  rawStart: number;
  rawEnd: number;
}

const WS = new Set([0, 9, 10, 12, 13, 32]);

function isDelimiter(c: number): boolean {
  // ( ) < > [ ] / % plus whitespace
  return (
    WS.has(c) ||
    c === 40 || c === 41 || c === 60 || c === 62 ||
    c === 91 || c === 93 || c === 47 || c === 37
  );
}

function isRegularChar(c: number): boolean {
  return !isDelimiter(c);
}

class Parser {
  pos = 0;
  constructor(public data: Uint8Array) {}

  get length(): number {
    return this.data.length;
  }

  skipWhitespaceAndComments(): void {
    while (this.pos < this.data.length) {
      const c = this.data[this.pos]!;
      if (WS.has(c)) {
        this.pos++;
      } else if (c === 37) {
        // '%' comment: skip to end of line
        while (this.pos < this.data.length) {
          const cc = this.data[this.pos]!;
          this.pos++;
          if (cc === 10 || cc === 13) break;
        }
      } else {
        break;
      }
    }
  }

  readName(): string {
    // current char is '/'
    this.pos++;
    let name = '';
    while (this.pos < this.data.length) {
      const c = this.data[this.pos]!;
      if (!isRegularChar(c)) break;
      if (c === 35) {
        // '#xx' hex escape inside a name
        const hex = String.fromCharCode(this.data[this.pos + 1] ?? 0, this.data[this.pos + 2] ?? 0);
        name += String.fromCharCode(parseInt(hex, 16));
        this.pos += 3;
      } else {
        name += String.fromCharCode(c);
        this.pos++;
      }
    }
    return name;
  }

  readLiteralString(): number[] {
    // current char is '('
    this.pos++;
    const bytes: number[] = [];
    let depth = 1;
    while (this.pos < this.data.length) {
      const c = this.data[this.pos]!;
      this.pos++;
      if (c === 92) {
        // escape
        const e = this.data[this.pos]!;
        this.pos++;
        switch (e) {
          case 110: bytes.push(10); break; // \n
          case 114: bytes.push(13); break; // \r
          case 116: bytes.push(9); break;  // \t
          case 98: bytes.push(8); break;   // \b
          case 102: bytes.push(12); break; // \f
          case 40: bytes.push(40); break;
          case 41: bytes.push(41); break;
          case 92: bytes.push(92); break;
          case 10: break; // line continuation
          case 13:
            if (this.data[this.pos] === 10) this.pos++;
            break;
          default: {
            if (e >= 48 && e <= 55) {
              // up to 3 octal digits (first already read)
              let val = e - 48;
              for (let k = 0; k < 2; k++) {
                const d = this.data[this.pos];
                if (d !== undefined && d >= 48 && d <= 55) {
                  val = val * 8 + (d - 48);
                  this.pos++;
                } else break;
              }
              bytes.push(val & 0xff);
            } else {
              bytes.push(e);
            }
          }
        }
      } else if (c === 40) {
        depth++;
        bytes.push(c);
      } else if (c === 41) {
        depth--;
        if (depth === 0) return bytes;
        bytes.push(c);
      } else {
        bytes.push(c);
      }
    }
    throw new Error('unterminated literal string in content stream');
  }

  readHexString(): number[] {
    // current char is '<'
    this.pos++;
    let hex = '';
    while (this.pos < this.data.length) {
      const c = this.data[this.pos]!;
      this.pos++;
      if (c === 62) break;
      if (WS.has(c)) continue;
      hex += String.fromCharCode(c);
    }
    if (hex.length % 2 === 1) hex += '0';
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.slice(i, i + 2), 16));
    }
    return bytes;
  }

  readNumber(): number {
    const start = this.pos;
    while (this.pos < this.data.length) {
      const c = this.data[this.pos]!;
      if (!((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) break;
      this.pos++;
    }
    const text = String.fromCharCode(...this.data.slice(start, this.pos));
    const value = Number(text);
    if (Number.isNaN(value)) throw new Error(`bad number token: ${text}`);
    return value;
  }

  readOperator(): string {
    const start = this.pos;
    while (this.pos < this.data.length && isRegularChar(this.data[this.pos]!)) {
      this.pos++;
    }
    return String.fromCharCode(...this.data.slice(start, this.pos));
  }
}

export function parseContentStream(data: Uint8Array): ContentOp[] {
  const p = new Parser(data);
  const ops: ContentOp[] = [];
  let operands: Operand[] = [];
  let firstOperandStart = -1;

  const noteOperand = (start: number) => {
    if (firstOperandStart < 0) firstOperandStart = start;
  };

  while (true) {
    p.skipWhitespaceAndComments();
    if (p.pos >= p.length) break;
    const start = p.pos;
    const c = p.data[p.pos]!;
    if (c === 47) {
      noteOperand(start);
      operands.push({ kind: 'name', value: p.readName() });
    } else if (c === 40) {
      noteOperand(start);
      operands.push({ kind: 'string', bytes: p.readLiteralString() });
    } else if (c === 60) {
      if (p.data[p.pos + 1] === 60) throw new Error('dicts not supported in content stream');
      noteOperand(start);
      operands.push({ kind: 'string', bytes: p.readHexString() });
    } else if (c === 91) {
      // TJ array
      noteOperand(start);
      p.pos++;
      const items: Array<{ kind: 'number'; value: number } | { kind: 'string'; bytes: number[] }> = [];
      while (true) {
        p.skipWhitespaceAndComments();
        const cc = p.data[p.pos];
        if (cc === undefined) throw new Error('unterminated TJ array');
        if (cc === 93) {
          p.pos++;
          break;
        } else if (cc === 40) {
          items.push({ kind: 'string', bytes: p.readLiteralString() });
        } else if (cc === 60) {
          items.push({ kind: 'string', bytes: p.readHexString() });
        } else {
          items.push({ kind: 'number', value: p.readNumber() });
        }
      }
      operands.push({ kind: 'array', items });
    } else if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      noteOperand(start);
      operands.push({ kind: 'number', value: p.readNumber() });
    } else {
      const name = p.readOperator();
      if (name.length === 0) throw new Error(`unexpected byte ${c} in content stream`);
      ops.push({
        name,
        operands,
        rawStart: firstOperandStart >= 0 ? firstOperandStart : start,
        rawEnd: p.pos,
      });
      operands = [];
      firstOperandStart = -1;
    }
  }
  if (operands.length > 0) throw new Error('trailing operands without operator');
  return ops;
}

/** Serialize a PDF literal string for the given bytes. */
export function encodeLiteralString(bytes: number[]): string {
  let out = '(';
  for (const b of bytes) {
    if (b === 40 || b === 41 || b === 92) {
      out += '\\' + String.fromCharCode(b);
    } else if (b >= 32 && b <= 126) {
      out += String.fromCharCode(b);
    } else {
      out += '\\' + b.toString(8).padStart(3, '0');
    }
  }
  return out + ')';
}

/** Format a number for content-stream output (enough precision for 0.01pt). */
export function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  let s = n.toFixed(6);
  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s === '-0' ? '0' : s;
}
