import assert from "node:assert/strict";
import test from "node:test";
import { watermark } from "../src/index.ts";
import {
  appendRevision,
  buildPdf,
  streamLengthObject,
  streamWithIndirectLength,
} from "./helpers.ts";
import { loadPdf, pageText } from "./pdfjs.ts";

const LABEL = "ivan(1)\\2026-10-04T00:00:00Z";

function buildTwoRevisionPdf(): Uint8Array {
  const rev1Content = "BT /F1 12 Tf 10 380 Td (rev1-content) Tj ET";
  const base = buildPdf({
    objects: new Map([
      [1, { body: "<< /Type /Catalog /Pages 2 0 R >>" }],
      [2, { body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" }],
      [
        3,
        {
          body:
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] " +
            "/Resources << /Font << /F1 5 2 R >> >> " +
            "/Contents 4 0 R /Annots [7 0 R] >>",
        },
      ],
      [4, { body: streamWithIndirectLength(6, rev1Content) }],
      // Non-zero generation object, referenced as "5 2 R".
      [
        5,
        {
          gen: 2,
          body: "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
        },
      ],
      [6, { body: streamLengthObject(rev1Content) }],
      [
        7,
        {
          body:
            "<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] " +
            "/Contents (a note) >>",
        },
      ],
      [8, { body: "<< /Title (Original Title) /Author (tester) >>" }],
    ]),
    root: 1,
    info: 8,
  });
  // Second revision replaces the page's contents and resources.
  const rev2Content = "BT /F2 14 Tf 10 350 Td (rev2-content) Tj ET";
  return appendRevision(base, {
    objects: new Map([
      [
        3,
        {
          body:
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] " +
            "/Resources << /Font << /F2 10 0 R >> >> " +
            "/Contents 4 0 R /Annots [7 0 R] >>",
        },
      ],
      [4, { body: streamWithIndirectLength(9, rev2Content) }],
      [9, { body: streamLengthObject(rev2Content) }],
      [
        10,
        { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
      ],
    ]),
    root: 1,
    info: 8,
    size: 11,
  });
}

test("output keeps input as exact prefix and never mutates the input", () => {
  const input = buildTwoRevisionPdf();
  const snapshot = input.slice();
  const output = watermark(input, LABEL);
  assert.deepEqual(output.subarray(0, input.length), input);
  assert.deepEqual(input, snapshot);
  assert.ok(output.length > input.length);
});

test("latest revision wins: new content used, old content gone", async () => {
  const output = watermark(buildTwoRevisionPdf(), LABEL);
  const doc = await loadPdf(output);
  assert.equal(doc.numPages, 1);
  const page = await doc.getPage(1);
  const strings = await pageText(page);
  assert.ok(strings.includes("rev2-content"), `got: ${strings}`);
  assert.ok(!strings.includes("rev1-content"), `got: ${strings}`);
});

test("watermark label with parens and backslash decodes exactly", async () => {
  const input = buildTwoRevisionPdf();
  const output = watermark(input, LABEL);
  // The appended stream must contain the properly escaped literal string.
  const appended = Buffer.from(output.subarray(input.length)).toString("latin1");
  assert.ok(
    appended.includes("(ivan\\(1\\)\\\\2026-10-04T00:00:00Z)"),
    appended,
  );
  // An independent reader must decode it back to the exact label.
  const doc = await loadPdf(output);
  const page = await doc.getPage(1);
  const strings = await pageText(page);
  assert.ok(strings.includes(LABEL), `got: ${JSON.stringify(strings)}`);
});

test("annotations and document metadata survive", async () => {
  const output = watermark(buildTwoRevisionPdf(), LABEL);
  const doc = await loadPdf(output);
  const metadata = await doc.getMetadata();
  const info = (metadata as unknown as { info: Record<string, unknown> }).info;
  assert.equal(info.Title, "Original Title");
  assert.equal(info.Author, "tester");
  const page = await doc.getPage(1);
  const annotations = await (page as {
    getAnnotations: () => Promise<unknown[]>;
  }).getAnnotations();
  assert.equal(annotations.length, 1);
});

test("watermarking the output again preserves earlier watermarks", async () => {
  const first = watermark(buildTwoRevisionPdf(), LABEL);
  const secondLabel = "second(2)\\run";
  const second = watermark(first, secondLabel);
  assert.deepEqual(second.subarray(0, first.length), first);
  const doc = await loadPdf(second);
  assert.equal(doc.numPages, 1);
  const page = await doc.getPage(1);
  const strings = await pageText(page);
  assert.ok(strings.includes(LABEL), `got: ${strings}`);
  assert.ok(strings.includes(secondLabel), `got: ${strings}`);
  assert.ok(strings.includes("rev2-content"), `got: ${strings}`);
});
