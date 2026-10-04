/** Helpers to hand-craft PDF files (with multiple revisions) for tests. */

export interface RawObject {
  obj: number;
  gen: number;
  /** Object body without the "N G obj" / "endobj" wrapper. */
  body: string;
}

const encoder = new TextEncoder();

/**
 * Appends one revision to `base` (or starts a new file when null).
 * `trailerEntries` are raw dictionary entries, e.g. "/Root 1 0 R".
 */
export function makeRevision(
  base: Uint8Array | null,
  objects: RawObject[],
  trailerEntries: string,
  prevOffset: number | null,
): { bytes: Uint8Array; xrefOffset: number } {
  const baseLen = base?.length ?? 0;
  let text = base === null ? "%PDF-1.7\n" : "";
  const offsets = new Map<number, number>();
  for (const o of objects) {
    offsets.set(o.obj, baseLen + text.length);
    text += `${o.obj} ${o.gen} obj\n${o.body}\nendobj\n`;
  }
  const xrefOffset = baseLen + text.length;
  const sorted = [...objects].sort((a, b) => a.obj - b.obj);
  text += "xref\n";
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.obj === sorted[j]!.obj + 1) j++;
    text += `${sorted[i]!.obj} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) {
      const e = sorted[k]!;
      text += `${String(offsets.get(e.obj)!).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n \n`;
    }
    i = j + 1;
  }
  const maxObj = Math.max(...objects.map((o) => o.obj), 0);
  const size = Math.max(maxObj + 1, 16);
  text += `trailer\n<< ${trailerEntries} /Size ${size}`;
  if (prevOffset !== null) text += ` /Prev ${prevOffset}`;
  text += ` >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const tail = encoder.encode(text);
  const bytes = new Uint8Array(baseLen + tail.length);
  if (base) bytes.set(base, 0);
  bytes.set(tail, baseLen);
  return { bytes, xrefOffset };
}
