import type { PdfArray, PdfDict, PdfRef, PdfValue } from "./types.js";
import { dict, dictGet, dictSet, isKind, name } from "./types.js";
import type { PdfDocument } from "./parser.js";
import type { PageInfo } from "./pages.js";
import type { IncrementalWriter } from "./writer.js";
import { helveticaWidth } from "./metrics.js";
import { formatNumber } from "./serialize.js";

const BASE_FONT_SIZE = 18;
const MAX_WIDTH_FRACTION = 0.8;
const GRAY = 0.5;

const encoder = new TextEncoder();

function escapeLabel(label: string): string {
  let out = "";
  for (const ch of label) {
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\";
    out += ch;
  }
  return out;
}

function streamOf(contents: string): PdfValue {
  const data = encoder.encode(contents);
  return {
    kind: "stream",
    dict: dict([["Length", data.length]]),
    data,
  };
}

/** Picks a font resource name not present in the existing font dictionary. */
function pickFontName(existing: PdfDict | undefined): string {
  for (let i = 1; ; i++) {
    const candidate = `WMf${i}`;
    if (!existing || dictGet(existing, candidate) === undefined) return candidate;
  }
}

/** Resolves the Contents value to the list of indirect stream references. */
function contentRefs(doc: PdfDocument, contents: PdfValue | undefined): PdfRef[] {
  if (contents === undefined || contents === null) return [];
  if (isKind(contents, "ref")) {
    const resolved = doc.resolve(contents);
    if (isKind(resolved, "array")) return refsOf(resolved);
    return [contents];
  }
  if (isKind(contents, "array")) return refsOf(contents);
  return [];
}

function refsOf(value: PdfArray): PdfRef[] {
  const out: PdfRef[] = [];
  for (const item of value.items) {
    if (isKind(item, "ref")) out.push(item);
  }
  return out;
}

/** Plans and records all objects needed to watermark every page. */
export function applyWatermark(
  doc: PdfDocument,
  pages: PageInfo[],
  writer: IncrementalWriter,
  label: string,
): void {
  const fontRef = writer.addObject(
    dict([
      ["Type", name("Font")],
      ["Subtype", name("Type1")],
      ["BaseFont", name("Helvetica")],
      ["Encoding", name("WinAnsiEncoding")],
    ]),
  );

  const widthPer1000 = helveticaWidth(label);
  const escaped = escapeLabel(label);

  for (const page of pages) {
    const [x0, y0, x1, y1] = page.cropBox;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rotated = page.rotate === 90 || page.rotate === 270;
    const visibleWidth = rotated ? y1 - y0 : x1 - x0;

    let fontSize = BASE_FONT_SIZE;
    const widthAtBase = (BASE_FONT_SIZE * widthPer1000) / 1000;
    if (widthAtBase > MAX_WIDTH_FRACTION * visibleWidth) {
      fontSize = (BASE_FONT_SIZE * MAX_WIDTH_FRACTION * visibleWidth) / widthAtBase;
    }
    const textWidth = (fontSize * widthPer1000) / 1000;

    // Rotation to make the text horizontal in the rotated page view.
    const rad = (page.rotate * Math.PI) / 180;
    const cos = Math.round(Math.cos(rad));
    const sin = Math.round(Math.sin(rad));

    // Merge the effective font dictionary with the watermark font.
    const resources = doc.resolve(page.resources);
    const resourceDict = isKind(resources, "dict") ? resources : undefined;
    const oldFonts = resourceDict ? doc.resolve(dictGet(resourceDict, "Font")) : undefined;
    const oldFontDict = isKind(oldFonts, "dict") ? oldFonts : undefined;
    const fontName = pickFontName(oldFontDict);
    const fontDictRef = writer.addObject(
      dict([...(oldFontDict?.entries ?? []), [fontName, fontRef]]),
    );
    const resourcesRef = writer.addObject(
      dict([...(resourceDict?.entries ?? []).filter(([k]) => k !== "Font"), ["Font", fontDictRef]]),
    );

    // Wrap existing content in q/Q so leftover graphics state (transform,
    // clip, alpha) cannot leak into the watermark stream.
    const olds = contentRefs(doc, page.contents);
    const contentItems: PdfValue[] = [];
    if (olds.length > 0) {
      contentItems.push(writer.addObject(streamOf("q\n")));
      contentItems.push(...olds);
    }

    const lines: string[] = [];
    if (olds.length > 0) lines.push("Q");
    lines.push(
      "q",
      `${formatNumber(GRAY)} g`,
      `${cos} ${sin} ${-sin} ${cos} ${formatNumber(cx)} ${formatNumber(cy)} cm`,
      "BT",
      `/${fontName} ${formatNumber(fontSize)} Tf`,
      `${formatNumber(-textWidth / 2)} 0 Td`,
      `(${escaped}) Tj`,
      "ET",
      "Q",
      "",
    );
    contentItems.push(writer.addObject(streamOf(lines.join("\n"))));

    let newPage = dictSet(page.pageDict, "Contents", { kind: "array", items: contentItems });
    newPage = dictSet(newPage, "Resources", resourcesRef);
    writer.replaceObject(page.pageRef, newPage);
  }
}
