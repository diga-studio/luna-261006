import { loadDocument, getPageInfos, collectGarbage } from './pdfdoc';
import { collectGlyphs } from './walker';
import { findHits } from './analyze';
import { applyRedactions } from './rewrite';
import { GlyphHit, Region } from './types';

export { Region, Point, GlyphHit } from './types';
export { GlyphInstance } from './walker';

/** Returns the page and quad of every glyph hit by any region.
 *  Each drawn instance is listed independently. */
export async function preview(pdfBytes: Uint8Array, regions: Region[]): Promise<GlyphHit[]> {
  const doc = await loadDocument(pdfBytes);
  const pages = getPageInfos(doc);
  const hits = findHits(collectGlyphs(doc, pages), regions);
  return hits.map((h) => ({ page: h.page, quad: h.quad }));
}

/** Returns a new PDF with exactly the preview-hit glyphs truly removed.
 *  Hits the exact same glyph set as `preview`. Input bytes are not modified. */
export async function burnIn(pdfBytes: Uint8Array, regions: Region[]): Promise<Uint8Array> {
  const doc = await loadDocument(pdfBytes);
  const pages = getPageInfos(doc);
  const hits = findHits(collectGlyphs(doc, pages), regions);
  applyRedactions(doc, pages, hits);
  collectGarbage(doc);
  return doc.save({ useObjectStreams: false });
}

/** Internal/test helper: all glyph instances with chars and quads. */
export async function collectAllGlyphs(pdfBytes: Uint8Array) {
  const doc = await loadDocument(pdfBytes);
  const pages = getPageInfos(doc);
  return collectGlyphs(doc, pages);
}
