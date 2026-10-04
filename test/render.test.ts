import { test } from "node:test";
import assert from "node:assert/strict";
import { watermark } from "../src/index.js";
import { makeRevision } from "./pdfbuild.js";
import { loadPdf, type RenderedPage } from "./pdfjs.js";

const SCALE = 1.5;
const LABEL = "ivan(2026)\\UTC+0000";

// CropBox with non-zero origin inside a non-zero-origin MediaBox.
const CROP = "[36 50 576 742]";
const CROP_W = 540;
const CROP_H = 692;

/** Original content: leaves transform, clip and alpha state behind. */
const DIRTY_CONTENT = [
  "0.8 0 0 0.8 15 25 cm",
  "40 40 400 300 re W n",
  "/GS1 gs",
  "1 0 0 rg",
  "60 60 120 80 re f",
  "0 0 1 rg",
  "BT /F1 20 Tf 70 200 Td (BASE-FONT) Tj ET",
].join("\n");

const CLEAN_CONTENT_A = ["0 0.8 0 rg", "100 100 150 100 re f"].join("\n");
const CLEAN_CONTENT_B = ["0 0 0.8 rg", "120 220 80 60 re f"].join("\n");
const CLEAN_CONTENT_C = ["0.8 0.8 0 rg", "150 300 90 50 re f"].join("\n");

function streamObj(content: string): string {
  return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
}

/** Multi-level page tree, shared resources, four rotations. */
function buildInput(): Uint8Array {
  const page = (obj: number, parent: number, rotate: number, contents: string): string =>
    `<< /Type /Page /Parent ${parent} 0 R /CropBox ${CROP}` +
    (rotate ? ` /Rotate ${rotate}` : "") +
    (contents ? ` /Contents ${contents}` : "") +
    " >>";
  const rev = makeRevision(
    null,
    [
      { obj: 1, gen: 0, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      {
        obj: 2,
        gen: 0,
        body: `<< /Type /Pages /Kids [10 0 R 11 0 R] /Count 7 /MediaBox [10 20 622 812] >>`,
      },
      {
        obj: 10,
        gen: 0,
        body: "<< /Type /Pages /Parent 2 0 R /Kids [3 0 R 4 0 R] /Count 2 /Resources 12 0 R >>",
      },
      {
        obj: 11,
        gen: 0,
        body: "<< /Type /Pages /Parent 2 0 R /Kids [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R] /Count 5 /Resources 12 0 R >>",
      },
      // Shared by all pages through inheritance; must never be mutated.
      {
        obj: 12,
        gen: 0,
        body: "<< /Font << /F1 13 0 R >> /ExtGState << /GS1 14 0 R >> >>",
      },
      { obj: 13, gen: 0, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
      { obj: 14, gen: 0, body: "<< /Type /ExtGState /ca 0.5 /CA 0.5 >>" },
      { obj: 3, gen: 0, body: page(3, 10, 0, "20 0 R") },
      { obj: 4, gen: 0, body: page(4, 10, 90, "21 0 R") },
      { obj: 5, gen: 0, body: page(5, 11, 180, "22 0 R") },
      { obj: 6, gen: 0, body: page(6, 11, 270, "23 0 R") },
      // Contents as a direct array of stream references.
      { obj: 7, gen: 0, body: page(7, 11, 0, "[24 0 R 25 0 R]") },
      // Contents as an indirect reference to an array of streams.
      { obj: 8, gen: 0, body: page(8, 11, 0, "26 0 R") },
      // Page without any contents.
      { obj: 9, gen: 0, body: page(9, 11, 0, "") },
      { obj: 20, gen: 0, body: streamObj(DIRTY_CONTENT) },
      { obj: 21, gen: 0, body: streamObj(DIRTY_CONTENT) },
      { obj: 22, gen: 0, body: streamObj(DIRTY_CONTENT) },
      { obj: 23, gen: 0, body: streamObj(DIRTY_CONTENT) },
      { obj: 24, gen: 0, body: streamObj(CLEAN_CONTENT_A) },
      { obj: 25, gen: 0, body: streamObj(CLEAN_CONTENT_B) },
      { obj: 26, gen: 0, body: "[27 0 R]" },
      { obj: 27, gen: 0, body: streamObj(CLEAN_CONTENT_C) },
    ],
    "/Root 1 0 R",
    null,
  );
  return rev.bytes;
}

interface Diff {
  count: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  sumX: number;
  sumY: number;
  minGray: number;
}

function diffPages(a: RenderedPage, b: RenderedPage): Diff {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  const diff: Diff = {
    count: 0,
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    sumX: 0,
    sumY: 0,
    minGray: 255,
  };
  for (let i = 0; i < a.pixels.length; i += 4) {
    const dr = Math.abs(a.pixels[i]! - b.pixels[i]!);
    const dg = Math.abs(a.pixels[i + 1]! - b.pixels[i + 1]!);
    const db = Math.abs(a.pixels[i + 2]! - b.pixels[i + 2]!);
    if (Math.max(dr, dg, db) > 8) {
      const p = i / 4;
      const x = p % a.width;
      const y = Math.floor(p / a.width);
      diff.count++;
      diff.minX = Math.min(diff.minX, x);
      diff.maxX = Math.max(diff.maxX, x);
      diff.minY = Math.min(diff.minY, y);
      diff.maxY = Math.max(diff.maxY, y);
      diff.sumX += x;
      diff.sumY += y;
      diff.minGray = Math.min(diff.minGray, b.pixels[i]!, b.pixels[i + 1]!, b.pixels[i + 2]!);
    }
  }
  return diff;
}

test("rendered watermark position and appearance", async () => {
  const input = buildInput();
  const output = watermark(input, LABEL);

  // Shared/structural objects must not be redefined by the appended
  // revision (only the seven page dictionaries may be).
  const appended = Buffer.from(output.subarray(input.length)).toString("latin1");
  for (const obj of [2, 10, 11, 12, 13, 14]) {
    assert.ok(
      !new RegExp(`(^|\\n)${obj} 0 obj\\n`).test(appended),
      `shared object ${obj} was redefined`,
    );
  }

  const before = await loadPdf(input);
  const after = await loadPdf(output);
  assert.equal(after.numPages, 7);

  // Watermark text and original text are both present on every page.
  for (let p = 1; p <= 7; p++) {
    const text = await after.pageText(p);
    assert.ok(text.includes(LABEL), `page ${p}: label missing in ${text}`);
    if (p <= 4) assert.ok(text.includes("BASE-FONT"), `page ${p}: original text missing`);
  }

  const rotations = [0, 90, 180, 270, 0, 0, 0];
  for (let p = 1; p <= 7; p++) {
    const rotate = rotations[p - 1]!;
    const swapped = rotate === 90 || rotate === 270;
    const expectW = Math.ceil((swapped ? CROP_H : CROP_W) * SCALE);
    const expectH = Math.ceil((swapped ? CROP_W : CROP_H) * SCALE);

    const imgBefore = await before.renderPage(p, SCALE);
    const imgAfter = await after.renderPage(p, SCALE);
    assert.equal(imgAfter.width, expectW, `page ${p} width`);
    assert.equal(imgAfter.height, expectH, `page ${p} height`);

    const d = diffPages(imgBefore, imgAfter);
    assert.ok(d.count > 200, `page ${p}: watermark ink missing (count=${d.count})`);

    // All changes are confined to a horizontal band around the page center:
    // original graphics elsewhere are pixel-identical.
    const cy = imgAfter.height / 2;
    assert.ok(d.minY >= cy - 34, `page ${p}: diff above band (minY=${d.minY}, cy=${cy})`);
    assert.ok(d.maxY <= cy + 34, `page ${p}: diff below band (maxY=${d.maxY}, cy=${cy})`);

    // The band is much wider than tall: text is horizontal in the rotated view.
    const w = d.maxX - d.minX;
    const h = d.maxY - d.minY;
    assert.ok(w > 3 * h, `page ${p}: ink not horizontal (w=${w}, h=${h})`);

    // Baseline midpoint lands on the CropBox center (viewport center).
    const meanX = d.sumX / d.count;
    const meanY = d.sumY / d.count;
    assert.ok(
      Math.abs(meanX - imgAfter.width / 2) <= imgAfter.width * 0.05,
      `page ${p}: center x off (mean=${meanX}, want ${imgAfter.width / 2})`,
    );
    assert.ok(
      Math.abs(meanY - cy) <= 12,
      `page ${p}: center y off (mean=${meanY}, want ${cy})`,
    );

    // 50% gray, fully opaque ink (inherited alpha 0.5 would give ~191).
    assert.ok(
      d.minGray >= 100 && d.minGray <= 170,
      `page ${p}: ink gray ${d.minGray} outside [100,170]`,
    );
  }

  await before.close();
  await after.close();
});
