/** Tokenizer and serializer for PDF content streams, limited to the operator
 *  set this library supports (q Q cm BT ET Tf Tm Td Tj TJ Do) but tolerant of
 *  any well-formed operands. Tokens keep their raw text so untouched parts of
 *  a stream round-trip exactly. */

export type ContentToken =
  | { type: 'number'; raw: string; value: number }
  | { type: 'name'; raw: string; name: string }
  | { type: 'string'; raw: string; bytes: Uint8Array }
  | { type: 'array'; raw: string; elements: ContentToken[] }
  | { type: 'operator'; raw: string; op: string };

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x2f, 0x25]); // ( ) < > [ ] / %

function latin1(data: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(data[i]!);
  return out;
}

class Tokenizer {
  pos = 0;
  constructor(private data: Uint8Array) {}

  private skipWsAndComments(): void {
    const d = this.data;
    for (;;) {
      while (this.pos < d.length && WS.has(d[this.pos]!)) this.pos++;
      if (d[this.pos] === 0x25) {
        // comment: skip to end of line
        while (this.pos < d.length && d[this.pos] !== 0x0a && d[this.pos] !== 0x0d) this.pos++;
        continue;
      }
      return;
    }
  }

  tokenizeAll(): ContentToken[] {
    const out: ContentToken[] = [];
    for (;;) {
      this.skipWsAndComments();
      if (this.pos >= this.data.length) return out;
      out.push(this.readToken());
    }
  }

  private readToken(): ContentToken {
    const d = this.data;
    const start = this.pos;
    const b = d[this.pos]!;
    if (b === 0x28) return this.readLiteralString();
    if (b === 0x3c) return this.readHexString();
    if (b === 0x5b) return this.readArray();
    if (b === 0x2f) return this.readName();
    // number or operator/keyword
    while (this.pos < d.length && !WS.has(d[this.pos]!) && !DELIMS.has(d[this.pos]!)) this.pos++;
    const raw = latin1(d, start, this.pos);
    if (raw.length === 0) throw new Error(`content stream: unexpected byte 0x${b.toString(16)} at ${start}`);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) {
      return { type: 'number', raw, value: parseFloat(raw) };
    }
    return { type: 'operator', raw, op: raw };
  }

  private readLiteralString(): ContentToken {
    const d = this.data;
    const start = this.pos;
    this.pos++; // consume '('
    const bytes: number[] = [];
    let depth = 1;
    while (this.pos < d.length && depth > 0) {
      const b = d[this.pos]!;
      if (b === 0x5c) {
        // escape
        const next = d[this.pos + 1];
        this.pos++;
        if (next === undefined) break;
        this.pos++;
        switch (next) {
          case 0x6e: bytes.push(0x0a); break;
          case 0x72: bytes.push(0x0d); break;
          case 0x74: bytes.push(0x09); break;
          case 0x62: bytes.push(0x08); break;
          case 0x66: bytes.push(0x0c); break;
          case 0x28: bytes.push(0x28); break;
          case 0x29: bytes.push(0x29); break;
          case 0x5c: bytes.push(0x5c); break;
          case 0x0a: break; // line continuation
          case 0x0d:
            if (d[this.pos] === 0x0a) this.pos++;
            break;
          default:
            if (next >= 0x30 && next <= 0x39) {
              // up to 3 octal digits; first digit already consumed
              let val = next - 0x30;
              for (let i = 0; i < 2; i++) {
                const dd = d[this.pos];
                if (dd !== undefined && dd >= 0x30 && dd <= 0x37) {
                  val = val * 8 + (dd - 0x30);
                  this.pos++;
                } else break;
              }
              bytes.push(val & 0xff);
            } else {
              bytes.push(next);
            }
        }
        continue;
      }
      this.pos++;
      if (b === 0x28) {
        depth++;
        bytes.push(b);
      } else if (b === 0x29) {
        depth--;
        if (depth > 0) bytes.push(b);
      } else {
        bytes.push(b);
      }
    }
    if (depth !== 0) throw new Error('content stream: unterminated literal string');
    return { type: 'string', raw: latin1(d, start, this.pos), bytes: new Uint8Array(bytes) };
  }

  private readHexString(): ContentToken {
    const d = this.data;
    const start = this.pos;
    this.pos++; // consume '<'
    const nibbles: number[] = [];
    while (this.pos < d.length && d[this.pos] !== 0x3e) {
      const b = d[this.pos]!;
      this.pos++;
      if (WS.has(b)) continue;
      const v = b >= 0x30 && b <= 0x39 ? b - 0x30
        : b >= 0x41 && b <= 0x46 ? b - 0x41 + 10
        : b >= 0x61 && b <= 0x66 ? b - 0x61 + 10
        : -1;
      if (v < 0) throw new Error(`content stream: bad hex digit at ${this.pos - 1}`);
      nibbles.push(v);
    }
    if (this.pos >= d.length) throw new Error('content stream: unterminated hex string');
    this.pos++; // consume '>'
    if (nibbles.length % 2 === 1) nibbles.push(0);
    const bytes = new Uint8Array(nibbles.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (nibbles[2 * i]! << 4) | nibbles[2 * i + 1]!;
    return { type: 'string', raw: latin1(d, start, this.pos), bytes };
  }

  private readArray(): ContentToken {
    const d = this.data;
    const start = this.pos;
    this.pos++; // consume '['
    const elements: ContentToken[] = [];
    for (;;) {
      this.skipWsAndComments();
      if (this.pos >= d.length) throw new Error('content stream: unterminated array');
      if (d[this.pos] === 0x5d) {
        this.pos++;
        break;
      }
      elements.push(this.readToken());
    }
    return { type: 'array', raw: latin1(d, start, this.pos), elements };
  }

  private readName(): ContentToken {
    const d = this.data;
    const start = this.pos;
    this.pos++; // consume '/'
    let name = '';
    while (this.pos < d.length && !WS.has(d[this.pos]!) && !DELIMS.has(d[this.pos]!)) {
      const b = d[this.pos]!;
      if (b === 0x23 && this.pos + 2 < d.length) {
        const hex = latin1(d, this.pos + 1, this.pos + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          name += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      name += String.fromCharCode(b);
      this.pos++;
    }
    return { type: 'name', raw: latin1(d, start, this.pos), name };
  }
}

export function tokenizeContent(data: Uint8Array): ContentToken[] {
  return new Tokenizer(data).tokenizeAll();
}

export function serializeTokens(tokens: ContentToken[]): Uint8Array {
  const text = tokens.map((t) => t.raw).join(' ') + '\n';
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function escapeLiteral(bytes: Uint8Array): string {
  let out = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += '\\' + b.toString(8).padStart(3, '0');
  }
  return out + ')';
}

/** Build a literal-string token (with escaping) from raw bytes. */
export function literalStringToken(bytes: Uint8Array): ContentToken {
  return { type: 'string', raw: escapeLiteral(bytes), bytes };
}

/** Build a number token, formatting with round-trip precision. */
export function numberToken(value: number): ContentToken {
  const raw = String(value);
  return { type: 'number', raw, value };
}

/** Build an array token from element tokens. */
export function arrayToken(elements: ContentToken[]): ContentToken {
  const raw = '[ ' + elements.map((e) => e.raw).join(' ') + ' ]';
  return { type: 'array', raw, elements };
}

/** Build a name token. */
export function nameToken(name: string): ContentToken {
  return { type: 'name', raw: '/' + name, name };
}
