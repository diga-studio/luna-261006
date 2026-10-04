import type { PdfDict, PdfRef, PdfValue } from "./types.js";
import { isKind } from "./types.js";
import type { PdfDocument } from "./parser.js";
import { serializeStream, serializeValue } from "./serialize.js";

const encoder = new TextEncoder();

interface PendingObject {
  obj: number;
  gen: number;
  value: PdfValue;
}

/**
 * Appends an incremental revision: new/updated objects, a classic xref
 * section and a trailer chaining to the previous revision via /Prev.
 */
export class IncrementalWriter {
  private readonly pending: PendingObject[] = [];
  private nextObjNum: number;

  constructor(private readonly doc: PdfDocument) {
    this.nextObjNum = doc.maxObjNum + 1;
  }

  /** Allocates a fresh object number and records the value. */
  addObject(value: PdfValue): PdfRef {
    const ref: PdfRef = { kind: "ref", obj: this.nextObjNum, gen: 0 };
    this.nextObjNum++;
    this.pending.push({ obj: ref.obj, gen: 0, value });
    return ref;
  }

  /** Re-defines an existing object (same number and generation). */
  replaceObject(ref: PdfRef, value: PdfValue): void {
    this.pending.push({ obj: ref.obj, gen: ref.gen, value });
  }

  /** Produces the output file: original bytes plus the appended revision. */
  finish(): Uint8Array {
    const chunks: Uint8Array[] = [this.doc.bytes];
    let offset = this.doc.bytes.length;
    const push = (bytes: Uint8Array): number => {
      chunks.push(bytes);
      const at = offset;
      offset += bytes.length;
      return at;
    };

    push(encoder.encode("\n"));
    const offsets = new Map<number, number>();
    for (const obj of this.pending) {
      const body = isKind(obj.value, "stream")
        ? serializeStream(obj.value.dict, obj.value.data)
        : serializeValue(obj.value);
      const at = push(encoder.encode(`${obj.obj} ${obj.gen} obj\n`));
      push(body);
      push(encoder.encode("\nendobj\n"));
      offsets.set(obj.obj, at);
    }

    const xrefOffset = offset;
    const sorted = [...this.pending].sort((a, b) => a.obj - b.obj);
    let xref = "xref\n";
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1]!.obj === sorted[j]!.obj + 1) j++;
      xref += `${sorted[i]!.obj} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) {
        const entry = sorted[k]!;
        const off = offsets.get(entry.obj)!;
        xref += `${String(off).padStart(10, "0")} ${String(entry.gen).padStart(5, "0")} n \n`;
      }
      i = j + 1;
    }
    push(encoder.encode(xref));

    const size = Math.max(this.doc.maxObjNum, this.nextObjNum - 1) + 1;
    const trailer = buildTrailer(this.doc, size, this.doc.lastXrefOffset);
    push(encoder.encode("trailer\n"));
    push(serializeValue(trailer));
    push(encoder.encode(`\nstartxref\n${xrefOffset}\n%%EOF\n`));

    const out = new Uint8Array(offset);
    let pos = 0;
    for (const chunk of chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return out;
  }
}

/** Builds the trailer dictionary for the appended revision. */
export function buildTrailer(doc: PdfDocument, size: number, prevOffset: number): PdfDict {
  const entries: Array<[string, PdfValue]> = [];
  for (const [key, value] of doc.trailer.entries) {
    if (key === "Size" || key === "Prev" || key === "XRefStm") continue;
    entries.push([key, value]);
  }
  entries.push(["Size", size]);
  entries.push(["Prev", prevOffset]);
  return { kind: "dict", entries };
}
