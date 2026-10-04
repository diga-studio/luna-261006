import {
  arr,
  dict,
  name,
  ref,
  str,
  type PdfDict,
  type PdfDictEntry,
  type PdfValue,
} from "./types.ts";

export interface ParsedObject {
  readonly value: PdfValue;
  /** Offset just past the parsed object. */
  readonly end: number;
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
]);

function isWs(b: number): boolean {
  return WS.has(b);
}

function isDelim(b: number): boolean {
  return DELIM.has(b) || WS.has(b);
}

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

function skipWs(bytes: Uint8Array, pos: number): number {
  for (;;) {
    while (pos < bytes.length && isWs(bytes[pos]!)) pos++;
    if (bytes[pos] === 0x25) {
      // comment: skip to end of line
      while (
        pos < bytes.length &&
        bytes[pos] !== 0x0a &&
        bytes[pos] !== 0x0d
      )
        pos++;
    } else {
      return pos;
    }
  }
}

function keywordAt(bytes: Uint8Array, pos: number, word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    if (bytes[pos + i] !== word.charCodeAt(i)) return false;
  }
  const after = bytes[pos + word.length];
  return after === undefined || isDelim(after);
}

function parseName(bytes: Uint8Array, pos: number): ParsedObject {
  const start = pos;
  pos++; // skip '/'
  while (pos < bytes.length && !isDelim(bytes[pos]!)) pos++;
  return { value: name(latin1(bytes, start + 1, pos)), end: pos };
}

/** Decode a PDF name (without leading slash), resolving #xx escapes. */
export function decodeName(raw: string): string {
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

function parseLiteralString(bytes: Uint8Array, pos: number): ParsedObject {
  const start = pos;
  pos++; // skip '('
  let depth = 1;
  while (pos < bytes.length && depth > 0) {
    const b = bytes[pos]!;
    if (b === 0x5c) {
      pos += 2; // escape: skip backslash and next byte
      continue;
    }
    if (b === 0x28) depth++;
    else if (b === 0x29) depth--;
    pos++;
  }
  if (depth !== 0) throw new Error("unterminated literal string");
  return { value: str(latin1(bytes, start, pos)), end: pos };
}

function parseHexString(bytes: Uint8Array, pos: number): ParsedObject {
  const start = pos;
  pos++; // skip '<'
  while (pos < bytes.length && bytes[pos] !== 0x3e) pos++;
  if (pos >= bytes.length) throw new Error("unterminated hex string");
  pos++; // skip '>'
  return { value: str(latin1(bytes, start, pos)), end: pos };
}

function parseArray(bytes: Uint8Array, pos: number): ParsedObject {
  pos++; // skip '['
  const items: PdfValue[] = [];
  for (;;) {
    pos = skipWs(bytes, pos);
    if (bytes[pos] === 0x5d) return { value: arr(items), end: pos + 1 };
    const parsed = parseValue(bytes, pos);
    items.push(parsed.value);
    pos = parsed.end;
  }
}

function parseDict(bytes: Uint8Array, pos: number): ParsedObject {
  pos += 2; // skip '<<'
  const entries: PdfDictEntry[] = [];
  for (;;) {
    pos = skipWs(bytes, pos);
    if (bytes[pos] === 0x3e && bytes[pos + 1] === 0x3e) {
      return { value: dict(entries), end: pos + 2 };
    }
    if (bytes[pos] !== 0x2f) throw new Error(`expected name in dict at ${pos}`);
    const key = parseName(bytes, pos);
    const value = parseValue(bytes, skipWs(bytes, key.end));
    entries.push([decodeName((key.value as { raw: string }).raw.slice(1)), value.value]);
    pos = value.end;
  }
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)/;

function parseNumberOrRef(bytes: Uint8Array, pos: number): ParsedObject {
  const rest = latin1(bytes, pos, Math.min(bytes.length, pos + 64));
  const m1 = NUMBER_RE.exec(rest);
  if (!m1) throw new Error(`expected number at ${pos}`);
  const first = m1[0];
  const afterFirst = pos + first.length;
  // Try to read "<int> <int> R" as an indirect reference.
  if (/^[+-]?\d+$/.test(first)) {
    const p2 = skipWs(bytes, afterFirst);
    const rest2 = latin1(bytes, p2, Math.min(bytes.length, p2 + 64));
    const m2 = /^[+-]?\d+/.exec(rest2);
    if (m2) {
      const p3 = skipWs(bytes, p2 + m2[0].length);
      if (bytes[p3] === 0x52 && isDelim(bytes[p3 + 1] ?? 0x20)) {
        return {
          value: ref(Number(first), Number(m2[0])),
          end: p3 + 1,
        };
      }
    }
  }
  return { value: { kind: "num", raw: first }, end: afterFirst };
}

/** Parse a direct object (dict, array, name, string, number, ref, ...). */
export function parseValue(bytes: Uint8Array, offset: number): ParsedObject {
  const pos = skipWs(bytes, offset);
  const b = bytes[pos];
  if (b === undefined) throw new Error("unexpected end of data");
  if (b === 0x2f) return parseName(bytes, pos);
  if (b === 0x28) return parseLiteralString(bytes, pos);
  if (b === 0x5b) return parseArray(bytes, pos);
  if (b === 0x3c) {
    if (bytes[pos + 1] === 0x3c) return parseDict(bytes, pos);
    return parseHexString(bytes, pos);
  }
  if (isDigit(b) || b === 0x2b || b === 0x2d || b === 0x2e) {
    return parseNumberOrRef(bytes, pos);
  }
  if (keywordAt(bytes, pos, "true")) return { value: { kind: "bool", value: true }, end: pos + 4 };
  if (keywordAt(bytes, pos, "false")) return { value: { kind: "bool", value: false }, end: pos + 5 };
  if (keywordAt(bytes, pos, "null")) return { value: { kind: "null" }, end: pos + 4 };
  throw new Error(`unexpected byte 0x${b.toString(16)} at ${pos}`);
}

export interface IndirectObject extends ParsedObject {
  readonly obj: number;
  readonly gen: number;
}

/**
 * Parse an indirect object "N G obj ... endobj" at the given offset.
 * Streams need their /Length resolved; `resolveLength` resolves an indirect
 * length reference to a number.
 */
export function parseIndirectObject(
  bytes: Uint8Array,
  offset: number,
  resolveLength: (obj: number, gen: number) => number,
): IndirectObject {
  let pos = skipWs(bytes, offset);
  const header = /^(\d+)\s+(\d+)\s+obj\b/.exec(
    latin1(bytes, pos, Math.min(bytes.length, pos + 64)),
  );
  if (!header) throw new Error(`expected indirect object header at ${pos}`);
  const objNum = Number(header[1]);
  const genNum = Number(header[2]);
  pos += header[0].length;
  const parsed = parseValue(bytes, pos);
  pos = parsed.end;
  let value: PdfValue = parsed.value;
  if (value.kind === "dict") {
    const afterDict = skipWs(bytes, pos);
    if (keywordAt(bytes, afterDict, "stream")) {
      pos = afterDict + 6;
      // EOL after "stream": CRLF or LF (a lone CR is tolerated).
      if (bytes[pos] === 0x0d && bytes[pos + 1] === 0x0a) pos += 2;
      else if (bytes[pos] === 0x0a) pos += 1;
      else if (bytes[pos] === 0x0d) pos += 1;
      else throw new Error("expected EOL after stream keyword");
      const d = value as PdfDict;
      const lengthEntry = d.entries.find(([k]) => k === "Length");
      if (!lengthEntry) throw new Error(`stream object ${objNum} has no /Length`);
      const lv = lengthEntry[1];
      let length: number;
      if (lv.kind === "num") length = Number(lv.raw);
      else if (lv.kind === "ref") length = resolveLength(lv.obj, lv.gen);
      else throw new Error(`stream object ${objNum} has invalid /Length`);
      const data = bytes.slice(pos, pos + length);
      pos += length;
      // Skip EOL before endstream.
      if (bytes[pos] === 0x0d && bytes[pos + 1] === 0x0a) pos += 2;
      else if (bytes[pos] === 0x0a || bytes[pos] === 0x0d) pos += 1;
      if (!keywordAt(bytes, pos, "endstream")) {
        throw new Error(`expected endstream for object ${objNum}`);
      }
      pos += 9;
      value = { kind: "stream", dict: d, data };
    }
  }
  return { value, end: pos, obj: objNum, gen: genNum };
}

/** Decode a literal-string raw token (with parens) to its text bytes. */
export function decodeLiteralString(raw: string): string {
  if (!raw.startsWith("(")) throw new Error("not a literal string");
  let out = "";
  let i = 1;
  let depth = 1;
  while (i < raw.length && depth > 0) {
    const c = raw[i]!;
    if (c === "\\") {
      const n = raw[i + 1];
      switch (n) {
        case "n": out += "\n"; i += 2; continue;
        case "r": out += "\r"; i += 2; continue;
        case "t": out += "\t"; i += 2; continue;
        case "b": out += "\b"; i += 2; continue;
        case "f": out += "\f"; i += 2; continue;
        case "(": out += "("; i += 2; continue;
        case ")": out += ")"; i += 2; continue;
        case "\\": out += "\\"; i += 2; continue;
        case "\r":
          i += raw[i + 2] === "\n" ? 3 : 2;
          continue;
        case "\n":
          i += 2;
          continue;
        default:
          if (n && n >= "0" && n <= "7") {
            const oct = raw.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)![0];
            out += String.fromCharCode(parseInt(oct, 8));
            i += 1 + oct.length;
            continue;
          }
          out += n ?? "";
          i += 2;
          continue;
      }
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) { i++; break; }
    }
    out += c;
    i++;
  }
  return out;
}
