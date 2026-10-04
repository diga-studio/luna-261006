import assert from "node:assert/strict";
import test from "node:test";
import { watermark } from "../src/index.ts";
import { buildPdf, streamLengthObject, streamWithIndirectLength } from "./helpers.ts";
import { loadPdf, renderPage, type RenderedPage } from "./pdfjs.ts";

// Long enough to force the font-size shrink path on the narrower pages.
const LABEL = "ivan.petrov(2)\\2026-10-04T12:34:56Z-longsuffix";

/** Original page content: a marker rect drawn inside balanced q/Q, then
 *  deliberately leaked CTM, clip and alpha state at the end. */
function dirtyContent(markerX: number, markerY: number, extra = ""): string {
  return (
    "q\n" +
    "0 g\n" +
    `${markerX} ${markerY} 30 30 re f\n` +
    extra +
    "Q\n" +
    // Leaked graphics state: transform, clip and 50% alpha.
    "2 0 0 2 10 10 cm\n" +
    "0 0 40 40 re W n\n" +
    "/GS1 gs\n"
  );
}

const content11 = dirtyContent(50, 60, "BT /F1 10 Tf 50 300 Td (orig-text) Tj ET\n");
const content12 = dirtyContent(70, 80);
const content13 = "0 g\n5 5 20 20 re f\n";
const content14 = dirtyContent(90, 100);
const content16 = dirtyContent(110, 120);

function buildSharedResourcePdf(): Uint8Array {
  return buildPdf({
    objects: new Map([
      [1, { body: "<< /Type /Catalog /Pages 2 0 R >>" }],
      // Root of the page tree carries shared Resources and MediaBox.
      [
        2,
        {
          body:
            "<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 4 " +
            "/MediaBox [0 0 400 400] " +
            "/Resources << /Font << /F1 6 0 R >> /ExtGState << /GS1 7 0 R >> >> >>",
        },
      ],
      // Intermediate node with a non-zero-origin CropBox.
      [
        3,
        {
          body:
            "<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 " +
            "/CropBox [20 30 380 370] >>",
        },
      ],
      [4, { body: "<< /Type /Page /Parent 3 0 R /Contents 11 0 R >>" }],
      [
        5,
        {
          body:
            "<< /Type /Page /Parent 3 0 R " +
            "/Contents [12 0 R 13 0 R] /Rotate 90 >>",
        },
      ],
      [
        6,
        { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
      ],
      [7, { body: "<< /ca 0.5 /CA 0.5 >>" }],
      // Second subtree: own MediaBox/CropBox, Rotate inherited by page 9.
      [
        8,
        {
          body:
            "<< /Type /Pages /Parent 2 0 R /Kids [9 0 R 10 0 R] /Count 2 " +
            "/MediaBox [0 0 300 500] /CropBox [15 25 285 475] /Rotate 180 >>",
        },
      ],
      // Contents via an indirect array object.
      [9, { body: "<< /Type /Page /Parent 8 0 R /Contents 15 0 R >>" }],
      [
        10,
        {
          body: "<< /Type /Page /Parent 8 0 R /Contents 16 0 R /Rotate 270 >>",
        },
      ],
      [11, { body: `<< /Length ${content11.length} >>\nstream\n${content11}\nendstream` }],
      [12, { body: `<< /Length ${content12.length} >>\nstream\n${content12}\nendstream` }],
      [13, { body: `<< /Length ${content13.length} >>\nstream\n${content13}\nendstream` }],
      [14, { body: `<< /Length ${content14.length} >>\nstream\n${content14}\nendstream` }],
      [15, { body: "[ 14 0 R ]" }],
      [16, { body: streamWithIndirectLength(17, content16) }],
      [17, { body: streamLengthObject(content16) }],
    ]),
    root: 1,
  });
}

interface DiffPixel {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function diffPixels(before: RenderedPage, after: RenderedPage): DiffPixel[] {
  assert.equal(before.width, after.width);
  assert.equal(before.height, after.height);
  const diffs: DiffPixel[] = [];
  for (let i = 0; i < before.data.length; i += 4) {
    const dr = Math.abs(before.data[i]! - after.data[i]!);
    const dg = Math.abs(before.data[i + 1]! - after.data[i + 1]!);
    const db = Math.abs(before.data[i + 2]! - after.data[i + 2]!);
    if (Math.max(dr, dg, db) > 8) {
      const pixel = i / 4;
      diffs.push({
        x: pixel % after.width,
        y: Math.floor(pixel / after.width),
        r: after.data[i]!,
        g: after.data[i + 1]!,
        b: after.data[i + 2]!,
      });
    }
  }
  return diffs;
}

test("four rotations, shared resources, inherited boxes", async () => {
  const input = buildSharedResourcePdf();
  const snapshot = input.slice();
  const output = watermark(input, LABEL);
  assert.deepEqual(output.subarray(0, input.length), input);
  assert.deepEqual(input, snapshot);

  const docBefore = await loadPdf(input);
  const docAfter = await loadPdf(output);
  assert.equal(docAfter.numPages, 4);

  const expectedRotations = [0, 90, 180, 270];
  for (let pageNum = 1; pageNum <= 4; pageNum++) {
    const pageBefore = await docBefore.getPage(pageNum);
    const pageAfter = await docAfter.getPage(pageNum);
    assert.equal(
      (pageAfter as { rotate: number }).rotate,
      expectedRotations[pageNum - 1],
      `page ${pageNum} rotation`,
    );
    const before = await renderPage(pageBefore, 2);
    const after = await renderPage(pageAfter, 2);
    const diffs = diffPixels(before, after);

    // The watermark must be visible.
    assert.ok(diffs.length > 200, `page ${pageNum}: only ${diffs.length} diff px`);

    // All changes are confined to a horizontal band around the vertical
    // center of the displayed page: original graphics untouched.
    const centerY = after.height / 2;
    const centerX = after.width / 2;
    const bandHalfHeight = after.height * 0.08 + 10;
    const bandHalfWidth = after.width * 0.4 + 12;
    for (const d of diffs) {
      assert.ok(
        Math.abs(d.y - centerY) <= bandHalfHeight,
        `page ${pageNum}: diff at y=${d.y} outside center band (H=${after.height})`,
      );
      assert.ok(
        Math.abs(d.x - centerX) <= bandHalfWidth,
        `page ${pageNum}: diff at x=${d.x} exceeds 80% width rule (W=${after.width})`,
      );
    }

    // Watermark pixels are 50% gray (antialiased edges blend toward white).
    let solidGray = 0;
    for (const d of diffs) {
      assert.ok(
        Math.abs(d.r - d.g) <= 4 && Math.abs(d.g - d.b) <= 4,
        `page ${pageNum}: non-gray pixel ${d.r},${d.g},${d.b}`,
      );
      assert.ok(d.r >= 110, `page ${pageNum}: too dark pixel ${d.r}`);
      if (d.r >= 120 && d.r <= 136) solidGray++;
    }
    assert.ok(solidGray > 100, `page ${pageNum}: only ${solidGray} solid gray px`);

    // The band really is centered horizontally.
    const xs = diffs.map((d) => d.x);
    const meanX = (Math.min(...xs) + Math.max(...xs)) / 2;
    assert.ok(
      Math.abs(meanX - centerX) <= after.width * 0.03 + 4,
      `page ${pageNum}: watermark not centered (meanX=${meanX}, center=${centerX})`,
    );
  }
});

test("existing resources are merged, not overwritten", () => {
  const input = buildSharedResourcePdf();
  const output = watermark(input, LABEL);
  const appended = Buffer.from(output.subarray(input.length)).toString("latin1");
  // New font resource name must not collide with the existing /F1.
  assert.match(appended, /\/WmF1 \d+ 0 R/);
  // The inherited /F1 font reference is copied into the page resources.
  assert.ok(appended.includes("/F1 6 0 R"), appended);
  // The shared ExtGState is still referenced, not redefined.
  assert.ok(appended.includes("/GS1 7 0 R"), appended);
});
