import { PdfDocument } from "./parser.js";
import { collectPages } from "./pages.js";
import { IncrementalWriter } from "./writer.js";
import { applyWatermark } from "./watermark.js";

/**
 * Returns a new PDF (as bytes) equal to `input` plus an appended incremental
 * revision that draws `label` as a centered watermark on every page.
 * The input buffer is never modified.
 */
export function watermark(input: Uint8Array, label: string): Uint8Array {
  const doc = new PdfDocument(input);
  const pages = collectPages(doc);
  const writer = new IncrementalWriter(doc);
  applyWatermark(doc, pages, writer, label);
  return writer.finish();
}
