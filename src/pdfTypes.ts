/** PDF object model. All objects are represented as tagged unions so the
 *  parser, interpreter and writer share one vocabulary. */

export interface PdfName {
  kind: 'name';
  /** Name without the leading slash, with #XX escapes decoded. */
  value: string;
}

export interface PdfString {
  kind: 'string';
  /** Decoded string bytes (escapes resolved, hex decoded). */
  bytes: Uint8Array;
}

export interface PdfNumber {
  kind: 'number';
  value: number;
  /** Original lexical form, preserved so untouched numbers round-trip byte-exact. */
  raw: string;
}

export interface PdfBoolean {
  kind: 'boolean';
  value: boolean;
}

export interface PdfNull {
  kind: 'null';
}

export interface PdfRef {
  kind: 'ref';
  obj: number;
  gen: number;
}

export interface PdfArray {
  kind: 'array';
  items: PdfObject[];
}

export interface PdfDict {
  kind: 'dict';
  entries: Map<string, PdfObject>;
}

export interface PdfStream {
  kind: 'stream';
  dict: PdfDict;
  /** Raw stream bytes, still filtered (e.g. FlateDecode-compressed) exactly as in the file. */
  data: Uint8Array;
}

export type PdfObject =
  | PdfName
  | PdfString
  | PdfNumber
  | PdfBoolean
  | PdfNull
  | PdfRef
  | PdfArray
  | PdfDict
  | PdfStream;

export interface PdfDocument {
  /** Top-level indirect objects keyed by object number (generation is always 0 on output). */
  objects: Map<number, PdfObject>;
  /** Reference to the catalog, i.e. trailer /Root. */
  rootRef: PdfRef;
}

export function name(value: string): PdfName {
  return { kind: 'name', value };
}

export function num(value: number, raw?: string): PdfNumber {
  return { kind: 'number', value, raw: raw ?? String(value) };
}

export function ref(obj: number, gen = 0): PdfRef {
  return { kind: 'ref', obj, gen };
}

export function str(bytes: Uint8Array): PdfString {
  return { kind: 'string', bytes };
}

export function dict(entries: Iterable<readonly [string, PdfObject]>): PdfDict {
  return { kind: 'dict', entries: new Map(entries) }
}

export function arr(items: PdfObject[]): PdfArray {
  return { kind: 'array', items };
}

/** Dereference one level; returns the object itself when it is not a reference. */
export function deref(doc: PdfDocument, obj: PdfObject): PdfObject {
  if (obj.kind !== 'ref') return obj;
  const target = doc.objects.get(obj.obj);
  if (target === undefined) throw new Error(`dangling reference to object ${obj.obj}`);
  return target;
}

export function dictGet(doc: PdfDocument, d: PdfDict, key: string): PdfObject | undefined {
  const v = d.entries.get(key);
  return v === undefined ? undefined : deref(doc, v);
}

export function asNumber(doc: PdfDocument, obj: PdfObject | undefined): number | undefined {
  if (obj === undefined) return undefined;
  const o = deref(doc, obj);
  return o.kind === 'number' ? o.value : undefined;
}

export function asName(doc: PdfDocument, obj: PdfObject | undefined): string | undefined {
  if (obj === undefined) return undefined;
  const o = deref(doc, obj);
  return o.kind === 'name' ? o.value : undefined;
}
