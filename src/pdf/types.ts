/** Parsed PDF object model. Leaf values keep their raw source text so that
 *  unmodified objects can be re-serialized byte-for-byte. */

export interface PdfNull {
  readonly kind: "null";
}

export interface PdfBool {
  readonly kind: "bool";
  readonly value: boolean;
}

export interface PdfNumber {
  readonly kind: "num";
  /** Raw source text, e.g. "12", "-3.5". */
  readonly raw: string;
}

export interface PdfName {
  readonly kind: "name";
  /** Raw source text including the leading slash, e.g. "/Type". */
  readonly raw: string;
}

export interface PdfString {
  readonly kind: "str";
  /** Raw source text including delimiters (literal or hex string). */
  readonly raw: string;
}

export interface PdfArray {
  readonly kind: "arr";
  readonly items: PdfValue[];
}

export type PdfDictEntry = readonly [key: string, value: PdfValue];

export interface PdfDict {
  readonly kind: "dict";
  /** Keys are name values without the leading slash, in source order. */
  readonly entries: PdfDictEntry[];
}

export interface PdfRef {
  readonly kind: "ref";
  readonly obj: number;
  readonly gen: number;
}

export interface PdfStream {
  readonly kind: "stream";
  readonly dict: PdfDict;
  readonly data: Uint8Array;
}

export type PdfValue =
  | PdfNull
  | PdfBool
  | PdfNumber
  | PdfName
  | PdfString
  | PdfArray
  | PdfDict
  | PdfRef
  | PdfStream;

export function num(value: number): PdfNumber {
  return { kind: "num", raw: formatNumber(value) };
}

export function name(value: string): PdfName {
  return { kind: "name", raw: "/" + value };
}

export function str(raw: string): PdfString {
  return { kind: "str", raw };
}

export function arr(items: PdfValue[]): PdfArray {
  return { kind: "arr", items };
}

export function dict(entries: PdfDictEntry[]): PdfDict {
  return { kind: "dict", entries };
}

export function ref(obj: number, gen: number): PdfRef {
  return { kind: "ref", obj, gen };
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  let text = value.toFixed(6);
  text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

export function dictGet(d: PdfDict, key: string): PdfValue | undefined {
  for (const [k, v] of d.entries) if (k === key) return v;
  return undefined;
}

export function dictSet(d: PdfDict, key: string, value: PdfValue): PdfDict {
  const entries: PdfDictEntry[] = [];
  let replaced = false;
  for (const [k, v] of d.entries) {
    if (k === key) {
      if (!replaced) entries.push([key, value]);
      replaced = true;
    } else {
      entries.push([k, v]);
    }
  }
  if (!replaced) entries.push([key, value]);
  return { kind: "dict", entries };
}

export function asNumber(v: PdfValue | undefined): number | undefined {
  if (v && v.kind === "num") return Number(v.raw);
  return undefined;
}

export function asName(v: PdfValue | undefined): string | undefined {
  if (v && v.kind === "name") return v.raw.slice(1);
  return undefined;
}
