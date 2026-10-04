/** PDF object model used by the parser and writer. */

export interface PdfRef {
  kind: "ref";
  obj: number;
  gen: number;
}

export interface PdfName {
  kind: "name";
  /** Decoded name (without the leading slash). */
  value: string;
}

export interface PdfString {
  kind: "string";
  /** Decoded raw bytes of the string. */
  bytes: Uint8Array;
}

export interface PdfArray {
  kind: "array";
  items: PdfValue[];
}

export interface PdfDict {
  kind: "dict";
  /** Insertion-ordered entries; lookup uses the last matching key. */
  entries: Array<[string, PdfValue]>;
}

export interface PdfStream {
  kind: "stream";
  dict: PdfDict;
  data: Uint8Array;
}

export type PdfValue =
  | null
  | boolean
  | number
  | PdfName
  | PdfString
  | PdfArray
  | PdfDict
  | PdfStream
  | PdfRef;

export function name(value: string): PdfName {
  return { kind: "name", value };
}

export function str(bytes: Uint8Array): PdfString {
  return { kind: "string", bytes };
}

export function arr(items: PdfValue[]): PdfArray {
  return { kind: "array", items };
}

export function dict(entries: Array<[string, PdfValue]>): PdfDict {
  return { kind: "dict", entries };
}

export function ref(obj: number, gen: number): PdfRef {
  return { kind: "ref", obj, gen };
}

export function dictGet(d: PdfDict, key: string): PdfValue | undefined {
  for (let i = d.entries.length - 1; i >= 0; i--) {
    const entry = d.entries[i]!;
    if (entry[0] === key) return entry[1];
  }
  return undefined;
}

export function dictSet(d: PdfDict, key: string, value: PdfValue): PdfDict {
  const entries = d.entries.filter(([k]) => k !== key);
  entries.push([key, value]);
  return { kind: "dict", entries };
}

/** Value variants that carry a `kind` tag (i.e. all non-primitive values). */
export type PdfObjectValue =
  | PdfName
  | PdfString
  | PdfArray
  | PdfDict
  | PdfStream
  | PdfRef;

export function isObjectValue(v: PdfValue | undefined): v is PdfObjectValue {
  return typeof v === "object" && v !== null;
}

export function isKind<K extends PdfObjectValue["kind"]>(
  v: PdfValue | undefined,
  kind: K,
): v is Extract<PdfObjectValue, { kind: K }> {
  return isObjectValue(v) && v.kind === kind;
}
