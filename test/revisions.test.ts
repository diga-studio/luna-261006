import { test } from "node:test";
import assert from "node:assert/strict";
import { watermark } from "../src/index.js";
import { makeRevision } from "./pdfbuild.js";
import { loadPdf } from "./pdfjs.js";

function streamBody(content: string, length: string): string {
  return `<< /Length ${length} >>\nstream\n${content}\nendstream`;
}

const OLD_CONTENT = "BT /F1 30 Tf 50 300 Td (OLD-CONTENT) Tj ET";
const NEW_CONTENT = "BT /F2 30 Tf 50 300 Td (NEW-CONTENT) Tj ET";

/** Builds a two-revision PDF where rev 2 replaces page content and resources. */
function buildInput(): Uint8Array {
  const rev1 = makeRevision(
    null,
    [
      { obj: 1, gen: 0, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      {
        obj: 2,
        gen: 0,
        body: "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 400 600] >>",
      },
      {
        obj: 3,
        gen: 0,
        body: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Annots [10 0 R] /Resources << /Font << /F1 6 3 R >> >> >>",
      },
      { obj: 4, gen: 0, body: streamBody(OLD_CONTENT, String(OLD_CONTENT.length)) },
      // Non-zero object generation.
      { obj: 6, gen: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
      { obj: 5, gen: 0, body: "<< /Title (Evidence Doc) /Author (alice) >>" },
      {
        obj: 10,
        gen: 0,
        body: "<< /Type /Annot /Subtype /Text /Rect [10 10 60 40] /Contents (review-note) >>",
      },
    ],
    "/Root 1 0 R /Info 5 0 R",
    null,
  );
  const rev2 = makeRevision(
    rev1.bytes,
    [
      // Redefine the page: new contents (indirect length) and indirect resources.
      {
        obj: 3,
        gen: 0,
        body: "<< /Type /Page /Parent 2 0 R /Contents 7 0 R /Annots [10 0 R] /Resources 8 0 R >>",
      },
      { obj: 7, gen: 0, body: streamBody(NEW_CONTENT, "9 0 R") },
      { obj: 8, gen: 0, body: "<< /Font << /F2 6 3 R >> >>" },
      { obj: 9, gen: 0, body: String(NEW_CONTENT.length) },
    ],
    "/Root 1 0 R /Info 5 0 R",
    rev1.xrefOffset,
  );
  return rev2.bytes;
}

const LABEL_1 = "user(a)\\b [2026-10-04T08:00:00Z]";
const LABEL_2 = "second(pass)\\2026-10-04T09:30:00Z";

test("incremental watermark over multiple revisions", async () => {
  const input = buildInput();
  const inputSnapshot = input.slice();

  const output = watermark(input, LABEL_1);

  // The output starts with the exact input bytes; the input is untouched.
  assert.equal(output.length > input.length, true);
  assert.deepEqual(output.subarray(0, input.length), input);
  assert.deepEqual(input, inputSnapshot);

  const doc = await loadPdf(output);
  assert.equal(doc.numPages, 1);
  const text = await doc.pageText(1);
  // Latest revision content wins; replaced content is gone.
  assert.ok(text.includes("NEW-CONTENT"), `expected NEW-CONTENT in: ${text}`);
  assert.ok(!text.includes("OLD-CONTENT"), `unexpected OLD-CONTENT in: ${text}`);
  // Watermark text with escaped characters survives round-trip.
  assert.ok(text.includes(LABEL_1), `expected label in: ${text}`);

  // Annotations and document metadata survive the appended revision.
  const annots = await doc.pageAnnotations(1);
  assert.equal(annots.length, 1);
  const contentsObj = annots[0]!.contentsObj as { str?: string } | undefined;
  assert.equal(contentsObj?.str, "review-note");
  const info = await doc.metadataInfo();
  assert.equal(info.Title, "Evidence Doc");
  assert.equal(info.Author, "alice");
  await doc.close();

  // Watermarking the output again keeps the previous watermark.
  const output2 = watermark(output, LABEL_2);
  assert.deepEqual(output2.subarray(0, output.length), output);
  const doc2 = await loadPdf(output2);
  const text2 = await doc2.pageText(1);
  assert.ok(text2.includes("NEW-CONTENT"), `expected NEW-CONTENT in: ${text2}`);
  assert.ok(text2.includes(LABEL_1), `expected first label in: ${text2}`);
  assert.ok(text2.includes(LABEL_2), `expected second label in: ${text2}`);
  await doc2.close();
});
