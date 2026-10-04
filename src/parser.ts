import type { PdfDict, PdfRef, PdfValue } from "./types.js";
import { isKind } from "./types.js";

/** A parsed indirect object: its identifier and byte offset in the file. */
export interface XrefEntry {
  obj: number;
  gen: number;
  offset: number;
  inUse: boolean;
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIMS = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ()<>[]{}/%

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/**
 * Random-access reader for a syntactically valid, unencrypted PDF using
 * classic cross-reference tables (possibly chained via /Prev).
 */
export class PdfDocument {
  readonly bytes: Uint8Array;
  /** Latest trailer dictionary (from the most recent revision). */
  readonly trailer: PdfDict;
  /** Highest object number known to the cross-reference tables. */
  readonly maxObjNum: number;
  /** Byte offset of the most recent xref section (value of last startxref). */
  readonly lastXrefOffset: number;

  private readonly xref = new Map<string, XrefEntry>();
  private readonly objectCache = new Map<string, PdfValue>();
  private pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.lastXrefOffset = this.findStartXref();
    let offset: number | undefined = this.lastXrefOffset;
    let latestTrailer: PdfDict | undefined;
    while (offset !== undefined) {
      const section = this.parseXrefAt(offset);
      for (const entry of section.entries) {
        const key = `${entry.obj} ${entry.gen}`;
        if (!this.xref.has(key)) this.xref.set(key, entry);
      }
      if (!latestTrailer) latestTrailer = section.trailer;
      const prev = this.dictGetNumber(section.trailer, "Prev");
      offset = prev !== undefined ? prev : undefined;
    }
    if (!latestTrailer) throw new Error("no trailer found");
    this.trailer = latestTrailer;
    let max = 0;
    for (const entry of this.xref.values()) {
      if (entry.inUse && entry.obj > max) max = entry.obj;
    }
    this.maxObjNum = max;
  }

  /** Returns the parsed value of an indirect object, or undefined if absent. */
  getObject(ref: PdfRef): PdfValue | undefined {
    const key = `${ref.obj} ${ref.gen}`;
    const cached = this.objectCache.get(key);
    if (cached !== undefined) return cached;
    const entry = this.xref.get(key);
    if (!entry || !entry.inUse) return undefined;
    this.pos = entry.offset;
    this.skipWsAndComments();
    const objNum = this.parseIntToken();
    const genNum = this.parseIntToken();
    this.expectKeyword("obj");
    if (objNum !== ref.obj || genNum !== ref.gen) {
      throw new Error(`xref points to ${objNum} ${genNum}, expected ${ref.obj} ${ref.gen}`);
    }
    let value = this.parseValue();
    this.skipWsAndComments();
    if (isKind(value, "dict") && this.peekKeyword("stream")) {
      value = this.parseStreamBody(value);
    }
    this.objectCache.set(key, value);
    return value;
  }

  /** Resolves references (one level); other values are returned as-is. */
  resolve(value: PdfValue | undefined): PdfValue | undefined {
    if (isKind(value, "ref")) {
      return this.getObject(value);
    }
    return value;
  }

  /** Looks up a dictionary key, resolving a final reference if present. */
  resolveKey(d: PdfDict, key: string): PdfValue | undefined {
    for (let i = d.entries.length - 1; i >= 0; i--) {
      const entry = d.entries[i]!;
      if (entry[0] === key) return this.resolve(entry[1]);
    }
    return undefined;
  }

  private dictGetNumber(d: PdfDict, key: string): number | undefined {
    const v = this.resolveKey(d, key);
    return typeof v === "number" ? v : undefined;
  }

  // --- xref and trailer ---

  private findStartXref(): number {
    const tail = "startxref";
    const start = Math.max(0, this.bytes.length - 1024);
    for (let i = this.bytes.length - tail.length; i >= start; i--) {
      let ok = true;
      for (let j = 0; j < tail.length; j++) {
        if (this.bytes[i + j] !== tail.charCodeAt(j)) { ok = false; break; }
      }
      if (ok) {
        this.pos = i + tail.length;
        this.skipWsAndComments();
        return this.parseIntToken();
      }
    }
    throw new Error("startxref not found");
  }

  private parseXrefAt(offset: number): { entries: XrefEntry[]; trailer: PdfDict } {
    this.pos = offset;
    this.expectKeyword("xref");
    const entries: XrefEntry[] = [];
    for (;;) {
      this.skipWsAndComments();
      if (this.peekKeyword("trailer")) break;
      const first = this.parseIntToken();
      const count = this.parseIntToken();
      for (let i = 0; i < count; i++) {
        this.skipWsAndComments();
        const entryOffset = this.parseIntToken();
        const gen = this.parseIntToken();
        this.skipWsAndComments();
        const flag = String.fromCharCode(this.bytes[this.pos]!);
        this.pos++;
        entries.push({ obj: first + i, gen, offset: entryOffset, inUse: flag === "n" });
      }
    }
    this.expectKeyword("trailer");
    const trailer = this.parseValue();
    if (!isKind(trailer, "dict")) throw new Error("trailer is not a dictionary");
    return { entries, trailer };
  }

  // --- tokenizer ---

  private skipWsAndComments(): void {
    for (;;) {
      while (this.pos < this.bytes.length && WS.has(this.bytes[this.pos]!)) this.pos++;
      if (this.bytes[this.pos] === 37) {
        // '%' comment: skip to end of line
        while (this.pos < this.bytes.length && this.bytes[this.pos] !== 10 && this.bytes[this.pos] !== 13) this.pos++;
      } else {
        return;
      }
    }
  }

  private peekKeyword(word: string): boolean {
    for (let i = 0; i < word.length; i++) {
      if (this.bytes[this.pos + i] !== word.charCodeAt(i)) return false;
    }
    const next = this.bytes[this.pos + word.length];
    return next === undefined || WS.has(next) || DELIMS.has(next);
  }

  private expectKeyword(word: string): void {
    this.skipWsAndComments();
    if (!this.peekKeyword(word)) throw new Error(`expected '${word}' at ${this.pos}`);
    this.pos += word.length;
  }

  private parseIntToken(): number {
    this.skipWsAndComments();
    const start = this.pos;
    if (this.bytes[this.pos] === 43 || this.bytes[this.pos] === 45) this.pos++;
    while (this.pos < this.bytes.length && isDigit(this.bytes[this.pos]!)) this.pos++;
    if (this.pos === start) throw new Error(`expected integer at ${start}`);
    return parseInt(String.fromCharCode(...this.bytes.subarray(start, this.pos)), 10);
  }

  // --- object value parser ---

  parseValue(): PdfValue {
    this.skipWsAndComments();
    const c = this.bytes[this.pos];
    if (c === 60) {
      if (this.bytes[this.pos + 1] === 60) return this.parseDict();
      return this.parseHexString();
    }
    if (c === 91) return this.parseArray();
    if (c === 47) return this.parseName();
    if (c === 40) return this.parseLiteralString();
    if (c === 116) { this.expectKeyword("true"); return true; }
    if (c === 102) { this.expectKeyword("false"); return false; }
    if (c === 110) { this.expectKeyword("null"); return null; }
    return this.parseNumberOrRef();
  }

  private parseDict(): PdfDict {
    this.pos += 2; // <<
    const entries: Array<[string, PdfValue]> = [];
    for (;;) {
      this.skipWsAndComments();
      if (this.bytes[this.pos] === 62 && this.bytes[this.pos + 1] === 62) {
        this.pos += 2;
        return { kind: "dict", entries };
      }
      const key = this.parseName();
      if (!isKind(key, "name")) throw new Error("dictionary key is not a name");
      const value = this.parseValue();
      entries.push([key.value, value]);
    }
  }

  private parseArray(): PdfValue {
    this.pos++; // [
    const items: PdfValue[] = [];
    for (;;) {
      this.skipWsAndComments();
      if (this.bytes[this.pos] === 93) {
        this.pos++;
        return { kind: "array", items };
      }
      items.push(this.parseValue());
    }
  }

  private parseName(): PdfValue {
    this.pos++; // /
    const out: number[] = [];
    while (this.pos < this.bytes.length) {
      const c = this.bytes[this.pos]!;
      if (WS.has(c) || DELIMS.has(c)) break;
      if (c === 35 && isHex(this.bytes[this.pos + 1]) && isHex(this.bytes[this.pos + 2])) {
        out.push(parseInt(String.fromCharCode(this.bytes[this.pos + 1]!, this.bytes[this.pos + 2]!), 16));
        this.pos += 3;
      } else {
        out.push(c);
        this.pos++;
      }
    }
    return { kind: "name", value: String.fromCharCode(...out) };
  }

  private parseLiteralString(): PdfValue {
    this.pos++; // (
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.bytes.length && depth > 0) {
      const c = this.bytes[this.pos]!;
      this.pos++;
      if (c === 40) { depth++; out.push(c); }
      else if (c === 41) { depth--; if (depth > 0) out.push(c); }
      else if (c === 92) {
        const e = this.bytes[this.pos]!;
        this.pos++;
        switch (e) {
          case 110: out.push(10); break;
          case 114: out.push(13); break;
          case 116: out.push(9); break;
          case 98: out.push(8); break;
          case 102: out.push(12); break;
          case 40: out.push(40); break;
          case 41: out.push(41); break;
          case 92: out.push(92); break;
          case 10: break; // line continuation
          case 13: if (this.bytes[this.pos] === 10) this.pos++; break;
          default:
            if (isDigit(e) && e < 56) {
              let oct = e - 48;
              for (let i = 0; i < 2 && isDigit(this.bytes[this.pos]!) && this.bytes[this.pos]! < 56; i++) {
                oct = oct * 8 + (this.bytes[this.pos]! - 48);
                this.pos++;
              }
              out.push(oct & 0xff);
            } else {
              out.push(e);
            }
        }
      } else {
        out.push(c);
      }
    }
    return { kind: "string", bytes: new Uint8Array(out) };
  }

  private parseHexString(): PdfValue {
    this.pos++; // <
    const nibbles: number[] = [];
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 62) {
      const c = this.bytes[this.pos]!;
      this.pos++;
      if (WS.has(c)) continue;
      nibbles.push(parseInt(String.fromCharCode(c), 16));
    }
    this.pos++; // >
    if (nibbles.length % 2 === 1) nibbles.push(0);
    const out = new Uint8Array(nibbles.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (nibbles[2 * i]! << 4) | nibbles[2 * i + 1]!;
    return { kind: "string", bytes: out };
  }

  private parseNumberOrRef(): PdfValue {
    const start = this.pos;
    const first = this.parseNumberToken();
    if (!Number.isInteger(first)) return first;
    const saved = this.pos;
    try {
      this.skipWsAndComments();
      const second = this.parseNumberToken();
      this.skipWsAndComments();
      if (Number.isInteger(second) && this.bytes[this.pos] === 82 &&
          (this.pos + 1 >= this.bytes.length || WS.has(this.bytes[this.pos + 1]!) || DELIMS.has(this.bytes[this.pos + 1]!))) {
        this.pos++;
        return { kind: "ref", obj: first, gen: second };
      }
    } catch {
      // not a reference; fall through
    }
    this.pos = saved;
    return first;
  }

  private parseNumberToken(): number {
    this.skipWsAndComments();
    const start = this.pos;
    if (this.bytes[this.pos] === 43 || this.bytes[this.pos] === 45) this.pos++;
    while (this.pos < this.bytes.length && (isDigit(this.bytes[this.pos]!) || this.bytes[this.pos] === 46)) this.pos++;
    if (this.pos === start) throw new Error(`expected number at ${start}`);
    return parseFloat(String.fromCharCode(...this.bytes.subarray(start, this.pos)));
  }

  private parseStreamBody(dict: PdfDict): PdfValue {
    this.expectKeyword("stream");
    // EOL after 'stream': CRLF or LF (tolerate lone CR)
    if (this.bytes[this.pos] === 13) {
      this.pos++;
      if (this.bytes[this.pos] === 10) this.pos++;
    } else if (this.bytes[this.pos] === 10) {
      this.pos++;
    }
    const lengthValue = this.resolveKey(dict, "Length");
    if (typeof lengthValue !== "number") throw new Error("stream without valid /Length");
    const data = this.bytes.slice(this.pos, this.pos + lengthValue);
    this.pos += lengthValue;
    return { kind: "stream", dict, data };
  }
}

function isHex(c: number | undefined): boolean {
  if (c === undefined) return false;
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
