import { PdfDocument, type PageInfo } from "./pdf/document.ts";
import { helveticaWidth } from "./pdf/helvetica.ts";
import {
  ascii,
  serializeDict,
  serializeStream,
  serializeValue,
} from "./pdf/serialize.ts";
import {
  arr,
  dict,
  dictGet,
  dictSet,
  formatNumber,
  num,
  ref,
  type PdfDict,
  type PdfDictEntry,
  type PdfRef,
  type PdfValue,
} from "./pdf/types.ts";

const FONT_SIZE = 18;
const MAX_WIDTH_FRACTION = 0.8;
const GRAY = 0.5;

function escapeLiteral(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code > 0x7e) {
      throw new Error(`label must be printable ASCII, got 0x${code.toString(16)}`);
    }
    if (ch === "\\" || ch === "(" || ch === ")") out += "\\";
    out += ch;
  }
  return out;
}

interface NewObject {
  readonly obj: number;
  readonly gen: number;
  readonly body: Uint8Array;
}

function streamBody(data: string): Uint8Array {
  const bytes = ascii(data);
  return serializeStream(
    dict([["Length", num(bytes.length)]]),
    bytes,
  );
}

/** Collect the stream references of a page's /Contents entry. */
function contentsItems(doc: PdfDocument, page: PdfDict): PdfValue[] {
  const contents = dictGet(page, "Contents");
  if (contents === undefined) return [];
  if (contents.kind === "ref") {
    const resolved = doc.deepResolve(contents);
    if (resolved.kind === "stream") return [contents];
    if (resolved.kind === "arr") return [...resolved.items];
    throw new Error("unsupported /Contents value");
  }
  if (contents.kind === "arr") return [...contents.items];
  throw new Error("unsupported /Contents value");
}

/** Pick a font resource name that does not collide with existing ones. */
function pickFontName(existing: ReadonlySet<string>): string {
  for (let i = 1; ; i++) {
    const candidate = `WmF${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function buildWatermarkStream(
  label: string,
  fontName: string,
  page: PageInfo,
): Uint8Array {
  const [x0, y0, x1, y1] = page.cropBox;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rotated = page.rotate === 90 || page.rotate === 270;
  const visibleWidth = rotated ? y1 - y0 : x1 - x0;
  let fontSize = FONT_SIZE;
  let width = helveticaWidth(label, fontSize);
  if (width > MAX_WIDTH_FRACTION * visibleWidth) {
    fontSize = (fontSize * MAX_WIDTH_FRACTION * visibleWidth) / width;
    width = helveticaWidth(label, fontSize);
  }
  // Rotate the text so it reads horizontally in the rotated (displayed)
  // view: counter-rotate by the page's /Rotate angle.
  const angle = (page.rotate * Math.PI) / 180;
  const cos = Math.round(Math.cos(angle));
  const sin = Math.round(Math.sin(angle));
  const f = formatNumber;
  const content =
    "q\n" +
    `${f(cos)} ${f(sin)} ${f(-sin)} ${f(cos)} ${f(cx)} ${f(cy)} cm\n` +
    `${GRAY} g\n` +
    "BT\n" +
    `/${fontName} ${f(fontSize)} Tf\n` +
    `1 0 0 1 ${f(-width / 2)} 0 Tm\n` +
    `(${escapeLiteral(label)}) Tj\n` +
    "ET\n" +
    "Q\n";
  return streamBody(content);
}

/** Build the replacement /Resources dictionary for a page. */
function buildResources(
  doc: PdfDocument,
  page: PageInfo,
  fontRef: PdfRef,
): { resources: PdfDict; fontName: string } {
  const existing = page.resources;
  const resolved = existing !== undefined ? doc.deepResolve(existing) : undefined;
  if (resolved !== undefined && resolved.kind !== "dict") {
    throw new Error("/Resources is not a dictionary");
  }
  const baseEntries: PdfDictEntry[] = resolved ? [...resolved.entries] : [];
  const fontValue = resolved ? dictGet(resolved, "Font") : undefined;
  const fontResolved = fontValue !== undefined ? doc.deepResolve(fontValue) : undefined;
  if (fontResolved !== undefined && fontResolved.kind !== "dict") {
    throw new Error("/Font is not a dictionary");
  }
  const fontEntries: PdfDictEntry[] = fontResolved ? [...fontResolved.entries] : [];
  const fontName = pickFontName(new Set(fontEntries.map(([key]) => key)));
  const newFont = dict([...fontEntries, [fontName, fontRef]]);
  const resources = dictSet(dict(baseEntries), "Font", newFont);
  return { resources, fontName };
}

/**
 * Append a centered Helvetica watermark to every page of a PDF using an
 * incremental update. The output contains the input bytes as an exact
 * prefix; the input buffer is never modified.
 */
export function watermark(input: Uint8Array, label: string): Uint8Array {
  escapeLiteral(label); // validate early
  const doc = PdfDocument.load(input);
  const pages = doc.pages();
  if (pages.length === 0) return input.slice();

  const trailer = doc.xref.trailer;
  let maxObj = trailer.size - 1;
  for (const num of doc.xref.entries.keys()) {
    if (num > maxObj) maxObj = num;
  }
  let nextObj = maxObj + 1;

  const objects: NewObject[] = [];
  const addObject = (body: Uint8Array, objNum?: number, gen = 0): PdfRef => {
    const obj = objNum ?? nextObj++;
    objects.push({ obj, gen, body });
    return { kind: "ref", obj, gen };
  };

  const fontRef = addObject(
    ascii(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ),
  );
  // Wrap the original content in q/Q so any transform, clip or alpha state
  // it leaves behind cannot leak into the watermark.
  const openRef = addObject(streamBody("q\n"));
  const closeRef = addObject(streamBody("Q\n"));

  for (const page of pages) {
    const { resources, fontName } = buildResources(doc, page, fontRef);
    const wmRef = addObject(buildWatermarkStream(label, fontName, page));
    const items = contentsItems(doc, page.page);
    const contents = arr([
      openRef,
      ...items,
      closeRef,
      { kind: "ref", obj: wmRef.obj, gen: wmRef.gen },
    ]);
    let pageDict = dictSet(page.page, "Contents", contents);
    pageDict = dictSet(pageDict, "Resources", resources);
    const entry = doc.xref.entries.get(page.pageRef.obj);
    addObject(ascii(serializeDict(pageDict)), page.pageRef.obj, entry?.gen ?? 0);
  }

  // Serialize the appended objects and record their offsets.
  const needsEol =
    input.length > 0 &&
    input[input.length - 1] !== 0x0a &&
    input[input.length - 1] !== 0x0d;
  const chunks: Uint8Array[] = [input];
  let offset = input.length;
  if (needsEol) {
    chunks.push(ascii("\n"));
    offset += 1;
  }
  const written = new Map<number, { gen: number; offset: number }>();
  for (const object of objects) {
    const head = ascii(`${object.obj} ${object.gen} obj\n`);
    const tail = ascii("\nendobj\n");
    chunks.push(head, object.body, tail);
    written.set(object.obj, { gen: object.gen, offset });
    offset += head.length + object.body.length + tail.length;
  }

  // xref section: group written objects into consecutive runs.
  const xrefOffset = offset;
  const sorted = [...written.entries()].sort((a, b) => a[0] - b[0]);
  let xrefText = "xref\n";
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]![0] === sorted[j]![0] + 1) j++;
    xrefText += `${sorted[i]![0]} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) {
      const [, info] = sorted[k]!;
      xrefText +=
        `${String(info.offset).padStart(10, "0")} ` +
        `${String(info.gen).padStart(5, "0")} n \n`;
    }
    i = j + 1;
  }

  // Trailer: carry /Root, /Info and /ID forward, chain via /Prev.
  const trailerEntries: PdfDictEntry[] = [
    ["Size", num(nextObj)],
  ];
  if (trailer.root) {
    trailerEntries.push(["Root", ref(trailer.root.obj, trailer.root.gen)]);
  }
  if (trailer.info) {
    trailerEntries.push(["Info", ref(trailer.info.obj, trailer.info.gen)]);
  }
  const idEntry = trailer.raw.entries.find(([key]) => key === "ID");
  if (idEntry) trailerEntries.push(["ID", idEntry[1]]);
  trailerEntries.push(["Prev", num(trailer.xrefOffset)]);
  const trailerText =
    `${xrefText}trailer\n${serializeValue(dict(trailerEntries))}\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(ascii(trailerText));

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}
