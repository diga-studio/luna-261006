import {
  num,
  type PdfDocument,
  type PdfDict,
  type PdfObject,
  type PdfStream,
} from './pdfTypes';

function escapeName(value: string): string {
  let out = '/';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const regular =
      c >= 0x21 && c <= 0x7e &&
      c !== 0x23 && c !== 0x25 && c !== 0x28 && c !== 0x29 && c !== 0x2f &&
      c !== 0x3c && c !== 0x3e && c !== 0x5b && c !== 0x5d && c !== 0x7b && c !== 0x7d;
    out += regular ? value[i] : '#' + c.toString(16).padStart(2, '0').toUpperCase();
  }
  return out;
}

function escapeString(bytes: Uint8Array): string {
  let out = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += '\\' + b.toString(8).padStart(3, '0');
  }
  return out + ')';
}

/** Collect every object reachable from the catalog, so unreferenced source
 *  objects (old content streams, orphaned forms) never appear in the output. */
function reachableObjects(doc: PdfDocument): number[] {
  const seen = new Set<number>();
  const stack: PdfObject[] = [doc.rootRef];
  const visit = (obj: PdfObject): void => {
    switch (obj.kind) {
      case 'ref':
        if (!seen.has(obj.obj)) {
          seen.add(obj.obj);
          const target = doc.objects.get(obj.obj);
          if (target !== undefined) visit(target);
        }
        break;
      case 'array':
        for (const item of obj.items) visit(item);
        break;
      case 'dict':
        for (const v of obj.entries.values()) visit(v);
        break;
      case 'stream':
        for (const v of obj.dict.entries.values()) visit(v);
        break;
      default:
        break;
    }
  };
  while (stack.length > 0) visit(stack.pop()!);
  return [...seen].sort((a, b) => a - b);
}

class Serializer {
  private chunks: Uint8Array[] = [];
  private length = 0;

  constructor(private renumber: Map<number, number>) {}

  get size(): number {
    return this.length;
  }

  writeText(text: string): void {
    const buf = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) buf[i] = text.charCodeAt(i) & 0xff;
    this.writeBytes(buf);
  }

  writeBytes(data: Uint8Array): void {
    this.chunks.push(data);
    this.length += data.length;
  }

  writeObject(obj: PdfObject): void {
    switch (obj.kind) {
      case 'name':
        this.writeText(escapeName(obj.value));
        break;
      case 'string':
        this.writeText(escapeString(obj.bytes));
        break;
      case 'number':
        this.writeText(obj.raw);
        break;
      case 'boolean':
        this.writeText(obj.value ? 'true' : 'false');
        break;
      case 'null':
        this.writeText('null');
        break;
      case 'ref': {
        const mapped = this.renumber.get(obj.obj);
        if (mapped === undefined) throw new Error(`reference to unreachable object ${obj.obj}`);
        this.writeText(`${mapped} 0 R`);
        break;
      }
      case 'array':
        this.writeText('[');
        for (const item of obj.items) {
          this.writeText(' ');
          this.writeObject(item);
        }
        this.writeText(' ]');
        break;
      case 'dict':
        this.writeDict(obj);
        break;
      case 'stream':
        this.writeStream(obj);
        break;
    }
  }

  private writeDict(d: PdfDict, overrideLength?: number): void {
    this.writeText('<<');
    for (const [k, v] of d.entries) {
      if (k === 'Length' && overrideLength !== undefined) continue;
      this.writeText(' ');
      this.writeText(escapeName(k));
      this.writeText(' ');
      this.writeObject(v);
    }
    if (overrideLength !== undefined) {
      this.writeText(' /Length ');
      this.writeObject(num(overrideLength));
    }
    this.writeText(' >>');
  }

  private writeStream(s: PdfStream): void {
    this.writeDict(s.dict, s.data.length);
    this.writeText('\nstream\n');
    this.writeBytes(s.data);
    this.writeText('\nendstream');
  }

  build(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** Serialize a document to a fresh PDF file: only objects reachable from the
 *  catalog are written, renumbered densely, with a single classic xref table
 *  and no incremental history. */
export function serializePdf(doc: PdfDocument): Uint8Array {
  const reachable = reachableObjects(doc);
  const renumber = new Map<number, number>();
  reachable.forEach((oldId, i) => renumber.set(oldId, i + 1));

  const s = new Serializer(renumber);
  s.writeText('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  const offsets: number[] = [];
  for (const oldId of reachable) {
    const obj = doc.objects.get(oldId)!;
    offsets.push(s.size);
    s.writeText(`${renumber.get(oldId)} 0 obj\n`);
    s.writeObject(obj);
    s.writeText('\nendobj\n');
  }
  const xrefStart = s.size;
  const count = reachable.length + 1;
  s.writeText(`xref\n0 ${count}\n`);
  s.writeText('0000000000 65535 f \n');
  for (const off of offsets) {
    s.writeText(off.toString().padStart(10, '0') + ' 00000 n \n');
  }
  const newRoot = renumber.get(doc.rootRef.obj);
  if (newRoot === undefined) throw new Error('catalog is not reachable');
  s.writeText(`trailer\n<< /Size ${count} /Root ${newRoot} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return s.build();
}
