import { parseIndirectObject, parseValue } from "./parser.ts";
import { asNumber, type PdfDict, type PdfValue } from "./types.ts";

export interface XrefEntry {
  readonly obj: number;
  readonly gen: number;
  readonly offset: number;
  readonly inUse: boolean;
}

export interface TrailerInfo {
  /** Byte offset of the most recent xref section (value of last startxref). */
  readonly xrefOffset: number;
  readonly root?: { obj: number; gen: number };
  readonly info?: { obj: number; gen: number };
  readonly size: number;
  readonly raw: PdfDict;
}

export interface XrefTable {
  /** Latest effective entry per object number (newest revision wins). */
  readonly entries: ReadonlyMap<number, XrefEntry>;
  readonly trailer: TrailerInfo;
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

function findLastStartxref(bytes: Uint8Array): number {
  // The spec only requires searching the last 1024 bytes; be more lenient.
  const tailStart = Math.max(0, bytes.length - 1024 * 1024);
  const tail = latin1(bytes, tailStart, bytes.length);
  const idx = tail.lastIndexOf("startxref");
  if (idx < 0) throw new Error("no startxref found");
  const m = /startxref\s+(\d+)/.exec(tail.slice(idx));
  if (!m) throw new Error("malformed startxref");
  return Number(m[1]);
}

function refOf(
  dict: PdfDict,
  key: string,
): { obj: number; gen: number } | undefined {
  for (const [k, v] of dict.entries) {
    if (k === key && v.kind === "ref") return { obj: v.obj, gen: v.gen };
  }
  return undefined;
}

function sizeOf(dict: PdfDict): number | undefined {
  for (const [k, v] of dict.entries) {
    if (k === "Size") return asNumber(v);
  }
  return undefined;
}

function prevOf(dict: PdfDict): number | undefined {
  for (const [k, v] of dict.entries) {
    if (k === "Prev") return asNumber(v);
  }
  return undefined;
}

interface OneSection {
  entries: XrefEntry[];
  trailer: PdfDict;
}

function parseXrefSection(bytes: Uint8Array, offset: number): OneSection {
  const head = latin1(bytes, offset, Math.min(bytes.length, offset + 16));
  if (!/^xref[ \t\r\n]/.test(head)) {
    throw new Error(`expected xref table at offset ${offset}`);
  }
  let pos = offset + 4;
  const entries: XrefEntry[] = [];
  for (;;) {
    // Skip whitespace between subsections.
    while (
      pos < bytes.length &&
      (bytes[pos] === 0x20 ||
        bytes[pos] === 0x0d ||
        bytes[pos] === 0x0a ||
        bytes[pos] === 0x09 ||
        bytes[pos] === 0x0c ||
        bytes[pos] === 0x00)
    ) {
      pos++;
    }
    const rest = latin1(bytes, pos, Math.min(bytes.length, pos + 64));
    if (/^trailer\b/.test(rest)) {
      pos += 7;
      break;
    }
    const sub = /^(\d+)[ \t]+(\d+)[ \t\r]*\n/.exec(rest);
    if (!sub) throw new Error(`malformed xref subsection at ${pos}`);
    pos += sub[0].length;
    const first = Number(sub[1]);
    const count = Number(sub[2]);
    for (let i = 0; i < count; i++) {
      const line = latin1(bytes, pos, Math.min(bytes.length, pos + 21));
      // Entries are normally 20 bytes ("nnnnnnnnnn ggggg n" + 2-byte EOL),
      // but tolerate single-byte line endings too.
      const m = /^(\d{10}) (\d{5}) ([nf])( \r\n| \n| \r|\r\n|\n|\r)/.exec(line);
      if (!m) throw new Error(`malformed xref entry at ${pos}`);
      entries.push({
        obj: first + i,
        gen: Number(m[2]),
        offset: Number(m[1]),
        inUse: m[3] === "n",
      });
      pos += m[0].length;
    }
  }
  const trailerParsed = parseValue(bytes, pos);
  if (trailerParsed.value.kind !== "dict") {
    throw new Error("expected trailer dictionary");
  }
  return { entries, trailer: trailerParsed.value };
}

/** Follow the startxref/Prev chain and merge all xref table sections. */
export function loadXrefTables(bytes: Uint8Array): XrefTable {
  const entries = new Map<number, XrefEntry>();
  let xrefOffset = findLastStartxref(bytes);
  let root: TrailerInfo["root"];
  let info: TrailerInfo["info"];
  let size: number | undefined;
  let latestTrailer: PdfDict | undefined;
  const seen = new Set<number>();
  for (;;) {
    if (seen.has(xrefOffset)) throw new Error("xref Prev chain loops");
    seen.add(xrefOffset);
    const section = parseXrefSection(bytes, xrefOffset);
    for (const entry of section.entries) {
      if (!entries.has(entry.obj)) entries.set(entry.obj, entry);
    }
    if (!latestTrailer) {
      latestTrailer = section.trailer;
      root = refOf(section.trailer, "Root");
      info = refOf(section.trailer, "Info");
      size = sizeOf(section.trailer);
    } else {
      root = root ?? refOf(section.trailer, "Root");
      info = info ?? refOf(section.trailer, "Info");
      size = size ?? sizeOf(section.trailer);
    }
    const prev = prevOf(section.trailer);
    if (prev === undefined) break;
    xrefOffset = prev;
  }
  if (!latestTrailer || size === undefined) {
    throw new Error("no trailer found");
  }
  const trailer: TrailerInfo = {
    xrefOffset: findLastStartxref(bytes),
    size,
    raw: latestTrailer,
    ...(root ? { root } : {}),
    ...(info ? { info } : {}),
  };
  return { entries, trailer };
}

/** Resolve an indirect /Length-style numeric object. */
export function resolveSmallInt(bytes: Uint8Array, obj: number, gen: number, entryOf: (obj: number) => XrefEntry | undefined): number {
  const entry = entryOf(obj);
  if (!entry) throw new Error(`object ${obj} not found`);
  const parsed = parseIndirectObject(bytes, entry.offset, (o, g) =>
    resolveSmallInt(bytes, o, g, entryOf),
  );
  const v: PdfValue = parsed.value;
  if (v.kind !== "num") throw new Error(`object ${obj} is not a number`);
  return Number(v.raw);
}
