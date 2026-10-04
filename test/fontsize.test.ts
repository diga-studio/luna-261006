import { test } from "node:test";
import assert from "node:assert/strict";
import { watermark } from "../src/index.js";
import { makeRevision } from "./pdfbuild.js";
import { loadPdf } from "./pdfjs.js";

const SCALE = 2;
const PAGE = 300; // 300 x 300 pt page

function buildInput(): Uint8Array {
  const content = "0.2 0.4 0.9 rg 20 20 60 40 re f";
  const rev = makeRevision(
    null,
    [
      { obj: 1, gen: 0, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      {
        obj: 2,
        gen: 0,
        body: `<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 ${PAGE} ${PAGE}] >>`,
      },
      {
        obj: 3,
        gen: 0,
        body: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> >>",
      },
      {
        obj: 4,
        gen: 0,
        body: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      },
    ],
    "/Root 1 0 R",
    null,
  );
  return rev.bytes;
}

function inkBBox(pixels: Uint8Array, width: number): {
  minX: number; maxX: number; minY: number; maxY: number; count: number;
} {
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, count: 0 };
  for (let i = 0; i < pixels.length; i += 4) {
    // Ink = clearly non-white and roughly gray (the watermark).
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const grayish = Math.abs(r - g) < 12 && Math.abs(g - b) < 12;
    if (r < 230 && grayish) {
      const p = i / 4;
      const x = p % width;
      const y = Math.floor(p / width);
      box.count++;
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minY = Math.min(box.minY, y);
      box.maxY = Math.max(box.maxY, y);
    }
  }
  return box;
}

test("font shrinks to fit 80% of the visible width", async () => {
  const label = "long-user-name-2026-10-04T08:15:30Z(extra)\\suffix";
  const output = watermark(buildInput(), label);
  const doc = await loadPdf(output);
  const text = await doc.pageText(1);
  assert.ok(text.includes(label), `label missing in: ${text}`);

  const img = await doc.renderPage(1, SCALE);
  const box = inkBBox(img.pixels, img.width);
  assert.ok(box.count > 100, "watermark ink missing");

  // Text width lands at ~80% of the visible page width.
  const inkWidth = box.maxX - box.minX + 1;
  const expected = 0.8 * PAGE * SCALE;
  assert.ok(
    Math.abs(inkWidth - expected) <= expected * 0.06,
    `ink width ${inkWidth}, expected ~${expected}`,
  );

  // Shrunk well below the 18pt default (~33px ascender+descender at this
  // scale; the fitted ~9.4pt font gives ~20px).
  const inkHeight = box.maxY - box.minY + 1;
  assert.ok(inkHeight < 26, `ink height ${inkHeight} too tall for a shrunk font`);
  assert.ok(inkHeight > 8, `ink height ${inkHeight} suspiciously small`);

  // Still centered on the page.
  const cx = (box.minX + box.maxX) / 2;
  assert.ok(Math.abs(cx - img.width / 2) <= img.width * 0.03, `center x ${cx}`);
  await doc.close();
});
