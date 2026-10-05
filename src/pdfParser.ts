import { inflateSync } from 'node:zlib';
import {
  arr,
  dict,
  name,
  num,
  ref,
  str,
  type PdfDocument,
  type PdfDict,
  type PdfName,
  type PdfObject,
  type PdfRef,
  type PdfStream,
} from './pdfTypes';

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

function latin1(data: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(data[i]!);
  return out;
}

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

/** Recursive-descent parser for PDF objects at a byte offset. */
class ObjectParser {
  pos: number;
  constructor(
    private bytes: Uint8Array,
    offset: number,
    private resolveRef: (obj: number) => PdfObject,
  ) {
    this.pos = offset;
  }

  private skipWs(): void {
    const d = this.bytes;
    for (;;) {
      while (this.pos < d.length && WS.has(d[this.pos]!)) this.pos++;
      if (d[this.pos] === 0x25) {
        while (this.pos < d.length && d[this.pos] !== 0x0a && d[this.pos] !== 0x0d) this.pos++;
        continue;
      }
      return;
    }
  }

  private peekWord(): string {
    let p = this.pos;
    while (p < this.bytes.length && !WS.has(this.bytes[p]!) && p - this.pos < 16) p++;
    return latin1(this.bytes, this.pos, p);
  }

  parseIndirect(): { obj: number; gen: number; value: PdfObject } {
    this.skipWs();
    const objNum = this.parseInt();
    this.skipWs();
    const gen = this.parseInt();
    this.skipWs();
    if (this.peekWord() !== 'obj') throw new Error(`expected 'obj' at ${this.pos}`);
    this.pos += 3;
    const value = this.parseValue();
    // maybe a stream
    const save = this.pos;
    this.skipWs();
    if (this.peekWord() === 'stream') {
      if (value.kind !== 'dict') throw new Error('stream without dict');
      this.pos += 6;
      // exactly one EOL after 'stream'
      if (this.bytes[this.pos] === 0x0d) {
        this.pos++;
        if (this.bytes[this.pos] === 0x0a) this.pos++;
      } else if (this.bytes[this.pos] === 0x0a) {
        this.pos++;
      } else {
        throw new Error(`expected EOL after 'stream' at ${this.pos}`);
      }
      const lengthObj = value.entries.get('Length');
      if (!lengthObj) throw new Error('stream without /Length');
      let length: number;
      if (lengthObj.kind === 'ref') {
        const resolved = this.resolveRef(lengthObj.obj);
        if (resolved.kind !== 'number') throw new Error('/Length ref is not a number');
        length = resolved.value;
      } else if (lengthObj.kind === 'number') {
        length = lengthObj.value;
      } else {
        throw new Error('bad /Length');
      }
      const data = this.bytes.subarray(this.pos, this.pos + length);
      this.pos += length;
      const stream: PdfStream = { kind: 'stream', dict: value, data };
      return { obj: objNum, gen, value: stream };
    }
    this.pos = save;
    return { obj: objNum, gen, value };
  }

  private parseInt(): number {
    const start = this.pos;
    while (this.pos < this.bytes.length && isDigit(this.bytes[this.pos]!)) this.pos++;
    if (this.pos === start) throw new Error(`expected integer at ${this.pos}`);
    return parseInt(latin1(this.bytes, start, this.pos), 10);
  }

  parseValue(): PdfObject {
    this.skipWs();
    const b = this.bytes[this.pos];
    if (b === undefined) throw new Error('unexpected end of data');
    if (b === 0x3c) {
      if (this.bytes[this.pos + 1] === 0x3c) return this.parseDict();
      return this.parseHexString();
    }
    if (b === 0x28) return this.parseLiteralString();
    if (b === 0x5b) return this.parseArray();
    if (b === 0x2f) return this.parseName();
    if (b === 0x74 && this.peekWord().startsWith('true')) {
      this.pos += 4;
      return { kind: 'boolean', value: true };
    }
    if (b === 0x66 && this.peekWord().startsWith('false')) {
      this.pos += 5;
      return { kind: 'boolean', value: false };
    }
    if (b === 0x6e && this.peekWord().startsWith('null')) {
      this.pos += 4;
      return { kind: 'null' };
    }
    // number, possibly part of an indirect reference "n g R"
    const start = this.pos;
    if (this.bytes[this.pos] === 0x2b || this.bytes[this.pos] === 0x2d) this.pos++;
    while (this.pos < this.bytes.length && (isDigit(this.bytes[this.pos]!) || this.bytes[this.pos] === 0x2e)) this.pos++;
    const raw = latin1(this.bytes, start, this.pos);
    if (raw.length === 0) throw new Error(`unexpected byte 0x${b.toString(16)} at ${this.pos}`);
    const value = parseFloat(raw);
    if (/^[+-]?\d+$/.test(raw)) {
      // lookahead for "g R"
      const save = this.pos;
      this.skipWs();
      const gStart = this.pos;
      while (this.pos < this.bytes.length && isDigit(this.bytes[this.pos]!)) this.pos++;
      if (this.pos > gStart) {
        const genRaw = latin1(this.bytes, gStart, this.pos);
        this.skipWs();
        if (this.bytes[this.pos] === 0x52) {
          this.pos++;
          return ref(value, parseInt(genRaw, 10));
        }
      }
      this.pos = save;
    }
    return num(value, raw);
  }

  private parseDict(): PdfDict {
    this.pos += 2; // <<
    const entries = new Map<string, PdfObject>();
    for (;;) {
      this.skipWs();
      if (this.bytes[this.pos] === 0x3e && this.bytes[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return dict(entries);
      }
      const key = this.parseName();
      entries.set(key.value, this.parseValue());
    }
  }

  private parseArray(): PdfObject {
    this.pos++; // [
    const items: PdfObject[] = [];
    for (;;) {
      this.skipWs();
      if (this.bytes[this.pos] === 0x5d) {
        this.pos++;
        return arr(items);
      }
      items.push(this.parseValue());
    }
  }

  private parseName(): PdfName {
    this.pos++; // /
    let value = '';
    const d = this.bytes;
    const isDelim = (x: number) =>
      WS.has(x) || x === 0x28 || x === 0x29 || x === 0x3c || x === 0x3e || x === 0x5b || x === 0x5d || x === 0x2f || x === 0x25;
    while (this.pos < d.length && !isDelim(d[this.pos]!)) {
      const b = d[this.pos]!;
      if (b === 0x23 && this.pos + 2 < d.length) {
        const hex = latin1(d, this.pos + 1, this.pos + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          value += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      value += String.fromCharCode(b);
      this.pos++;
    }
    return name(value);
  }

  private parseLiteralString(): PdfObject {
    this.pos++; // (
    const d = this.bytes;
    const bytes: number[] = [];
    let depth = 1;
    while (this.pos < d.length && depth > 0) {
      const b = d[this.pos]!;
      if (b === 0x5c) {
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
          case 0x0a: break;
          case 0x0d:
            if (d[this.pos] === 0x0a) this.pos++;
            break;
          default:
            if (next >= 0x30 && next <= 0x39) {
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
    if (depth !== 0) throw new Error('unterminated literal string');
    return str(new Uint8Array(bytes));
  }

  private parseHexString(): PdfObject {
    this.pos++; // <
    const d = this.bytes;
    const nibbles: number[] = [];
    while (this.pos < d.length && d[this.pos] !== 0x3e) {
      const b = d[this.pos]!;
      this.pos++;
      if (WS.has(b)) continue;
      const v = isDigit(b) ? b - 0x30
        : b >= 0x41 && b <= 0x46 ? b - 0x41 + 10
        : b >= 0x61 && b <= 0x66 ? b - 0x61 + 10
        : -1;
      if (v < 0) throw new Error(`bad hex digit at ${this.pos - 1}`);
      nibbles.push(v);
    }
    if (this.pos >= d.length) throw new Error('unterminated hex string');
    this.pos++;
    if (nibbles.length % 2 === 1) nibbles.push(0);
    const bytes = new Uint8Array(nibbles.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (nibbles[2 * i]! << 4) | nibbles[2 * i + 1]!;
    return str(bytes);
  }
}

/** Parse a standalone indirect object ("n g obj ... endobj") starting at offset. */
export function parseIndirectObjectAt(
  bytes: Uint8Array,
  offset: number,
  resolveRef: (obj: number) => PdfObject = () => {
    throw new Error('unresolvable stream /Length reference');
  },
): { obj: number; gen: number; value: PdfObject } {
  return new ObjectParser(bytes, offset, resolveRef).parseIndirect();
}

/** Parse a whole PDF file (classic xref table, no incremental updates). */
export function parsePdf(bytes: Uint8Array): PdfDocument {
  // locate startxref near the end of file
  const tailStart = Math.max(0, bytes.length - 1024);
  const tail = latin1(bytes, tailStart, bytes.length);
  const idx = tail.lastIndexOf('startxref');
  if (idx < 0) throw new Error('startxref not found');
  const xrefOffset = parseInt(tail.slice(idx + 9).trim(), 10);
  if (!Number.isFinite(xrefOffset)) throw new Error('bad startxref');

  if (latin1(bytes, xrefOffset, xrefOffset + 4) !== 'xref') {
    throw new Error('only classic xref tables are supported');
  }
  // parse xref subsections
  let pos = xrefOffset + 4;
  const offsets = new Map<number, number>();
  const skipWs = () => {
    while (pos < bytes.length && WS.has(bytes[pos]!)) pos++;
  };
  for (;;) {
    skipWs();
    if (latin1(bytes, pos, pos + 7) === 'trailer') {
      pos += 7;
      break;
    }
    const m = /^(\d+)\s+(\d+)/.exec(latin1(bytes, pos, Math.min(pos + 40, bytes.length)));
    if (!m) throw new Error(`bad xref subsection at ${pos}`);
    const first = parseInt(m[1]!, 10);
    const count = parseInt(m[2]!, 10);
    pos += m[0].length;
    for (let i = 0; i < count; i++) {
      skipWs();
      const entry = latin1(bytes, pos, pos + 20);
      const em = /^(\d{10})\s(\d{5})\s([nf])/.exec(entry);
      if (!em) throw new Error(`bad xref entry at ${pos}`);
      if (em[3] === 'n') offsets.set(first + i, parseInt(em[1]!, 10));
      pos += em[0].length;
    }
  }
  // trailer dict
  const objects = new Map<number, PdfObject>();
  const resolveRef = (n: number): PdfObject => {
    const off = offsets.get(n);
    if (off === undefined) throw new Error(`no xref entry for object ${n}`);
    return parseIndirectObjectAt(bytes, off, resolveRef).value;
  };
  const trailerParser = new ObjectParser(bytes, pos, resolveRef);
  const trailer = trailerParser.parseValue();
  if (trailer.kind !== 'dict') throw new Error('trailer is not a dict');
  const root = trailer.entries.get('Root');
  if (!root || root.kind !== 'ref') throw new Error('trailer has no /Root reference');

  for (const [objNum, off] of offsets) {
    if (objNum === 0) continue;
    const parsed = parseIndirectObjectAt(bytes, off, resolveRef);
    objects.set(parsed.obj, parsed.value);
  }
  return { objects, rootRef: root as PdfRef };
}

/** Decode a stream's data according to its /Filter (none or FlateDecode). */
export function decodeStreamData(dictObj: PdfDict, data: Uint8Array): Uint8Array {
  const filter = dictObj.entries.get('Filter');
  if (!filter) return data;
  const filters: string[] = [];
  if (filter.kind === 'name') filters.push(filter.value);
  else if (filter.kind === 'array') {
    for (const f of filter.items) {
      if (f.kind !== 'name') throw new Error('bad /Filter entry');
      filters.push(f.value);
    }
  } else {
    throw new Error('bad /Filter');
  }
  let out = data;
  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') {
      out = new Uint8Array(inflateSync(out));
    } else {
      throw new Error(`unsupported stream filter: ${f}`);
    }
  }
  return out;
}
