/** Test-side PDF construction helpers (independent of src/). */

export interface PdfObjectSpec {
  readonly gen?: number;
  readonly body: string;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export interface BuildOptions {
  /** Object number -> spec. Numbers need not be contiguous. */
  readonly objects: ReadonlyMap<number, PdfObjectSpec>;
  readonly root: number;
  readonly info?: number;
  readonly version?: string;
}

/** Build a complete single-revision PDF with a traditional xref table. */
export function buildPdf(options: BuildOptions): Uint8Array {
  const parts: Uint8Array[] = [
    ascii(`%PDF-${options.version ?? "1.4"}\n%\xE2\xE3\xCF\xD3\n`),
  ];
  let offset = parts[0]!.length;
  const offsets = new Map<number, { gen: number; offset: number }>();
  let maxObj = 0;
  for (const [num, spec] of [...options.objects.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const gen = spec.gen ?? 0;
    const chunk = ascii(`${num} ${gen} obj\n${spec.body}\nendobj\n`);
    parts.push(chunk);
    offsets.set(num, { gen, offset });
    offset += chunk.length;
    if (num > maxObj) maxObj = num;
  }
  const xrefOffset = offset;
  let xref = `xref\n0 ${maxObj + 1}\n`;
  xref += "0000000000 65535 f \n";
  for (let num = 1; num <= maxObj; num++) {
    const entry = offsets.get(num);
    if (entry) {
      xref +=
        `${String(entry.offset).padStart(10, "0")} ` +
        `${String(entry.gen).padStart(5, "0")} n \n`;
    } else {
      xref += "0000000000 00000 f \n";
    }
  }
  let trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${options.root} 0 R`;
  if (options.info !== undefined) trailer += ` /Info ${options.info} 0 R`;
  trailer += ` >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(ascii(xref + trailer));
  return concat(parts);
}

export interface RevisionOptions {
  readonly objects: ReadonlyMap<number, PdfObjectSpec>;
  readonly root: number;
  readonly info?: number;
  /** Total object count after this revision (trailer /Size). */
  readonly size: number;
}

/** Append an incremental revision (new xref section + /Prev chain). */
export function appendRevision(
  input: Uint8Array,
  options: RevisionOptions,
): Uint8Array {
  const tail = Buffer.from(input).toString("latin1");
  const m = /startxref\s+(\d+)/g;
  let prev = -1;
  for (let match = m.exec(tail); match; match = m.exec(tail)) {
    prev = Number(match[1]);
  }
  if (prev < 0) throw new Error("no startxref in input");

  const parts: Uint8Array[] = [input];
  let offset = input.length;
  const last = input[input.length - 1]!;
  if (last !== 0x0a && last !== 0x0d) {
    parts.push(ascii("\n"));
    offset += 1;
  }
  const written = new Map<number, { gen: number; offset: number }>();
  for (const [num, spec] of [...options.objects.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const gen = spec.gen ?? 0;
    const chunk = ascii(`${num} ${gen} obj\n${spec.body}\nendobj\n`);
    parts.push(chunk);
    written.set(num, { gen, offset });
    offset += chunk.length;
  }
  const xrefOffset = offset;
  const sorted = [...written.entries()].sort((a, b) => a[0] - b[0]);
  let xref = "xref\n";
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]![0] === sorted[j]![0] + 1) j++;
    xref += `${sorted[i]![0]} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) {
      const [, info] = sorted[k]!;
      xref +=
        `${String(info.offset).padStart(10, "0")} ` +
        `${String(info.gen).padStart(5, "0")} n \n`;
    }
    i = j + 1;
  }
  let trailer = `trailer\n<< /Size ${options.size} /Root ${options.root} 0 R`;
  if (options.info !== undefined) trailer += ` /Info ${options.info} 0 R`;
  trailer += ` /Prev ${prev} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(ascii(xref + trailer));
  return concat(parts);
}

/** A stream object body with an indirect /Length. */
export function streamWithIndirectLength(
  lengthObj: number,
  data: string,
): string {
  return `<< /Length ${lengthObj} 0 R >>\nstream\n${data}\nendstream`;
}

export function streamLengthObject(data: string): string {
  return String(data.length);
}
