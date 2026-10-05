import { describe, expect, it } from 'vitest';
import { burnIn, preview, type RedactionRegion } from '../src/index';
import { extractGlyphs, extractText, type GlyphInstance } from '../src/interpreter';
import { decodeStreamData, parsePdf } from '../src/pdfParser';
import { quadRectIntersectionArea } from '../src/geometry';
import type { PdfDocument, PdfObject } from '../src/pdfTypes';
import { COURIER_FONT, PdfBuilder } from './helpers';

const EPS = 1e-9;

function isHit(glyph: GlyphInstance, regions: RedactionRegion[]): boolean {
  return regions.some(
    (r) => r.page === glyph.pageIndex + 1 && quadRectIntersectionArea(glyph.quad, r) > EPS,
  );
}

/** Assert output glyphs are exactly the non-hit input glyphs, same order,
 *  same chars, same positions (well within the 0.01pt budget). */
function expectKeptGlyphsPreserved(
  inputBytes: Uint8Array,
  outputBytes: Uint8Array,
  regions: RedactionRegion[],
): void {
  const inGlyphs = extractGlyphs(parsePdf(inputBytes));
  const outGlyphs = extractGlyphs(parsePdf(outputBytes));
  const kept = inGlyphs.filter((g) => !isHit(g, regions));
  expect(outGlyphs.length).toBe(kept.length);
  for (let i = 0; i < kept.length; i++) {
    expect(outGlyphs[i]!.pageIndex).toBe(kept[i]!.pageIndex);
    expect(outGlyphs[i]!.char).toBe(kept[i]!.char);
    for (let c = 0; c < 4; c++) {
      expect(outGlyphs[i]!.quad[c]![0]).toBeCloseTo(kept[i]!.quad[c]![0], 6);
      expect(outGlyphs[i]!.quad[c]![1]).toBeCloseTo(kept[i]!.quad[c]![1], 6);
    }
  }
}

function expectPreviewBurnInConsistent(inputBytes: Uint8Array, regions: RedactionRegion[]): void {
  const hits = preview(inputBytes, regions);
  const out = burnIn(inputBytes, regions);
  const inGlyphs = extractGlyphs(parsePdf(inputBytes));
  const outGlyphs = extractGlyphs(parsePdf(out));
  expect(inGlyphs.length - outGlyphs.length).toBe(hits.length);
}

/* ------------------------------------------------------------------ */
/* Scenario 1: nested form shared across two pages, same-name resources */
/* ------------------------------------------------------------------ */

function buildSharedFormPdf(): Uint8Array {
  const b = new PdfBuilder();
  const font = b.add(COURIER_FONT); // 1
  const inner = b.addStream(
    `/Type /XObject /Subtype /Form /BBox [0 0 300 50] /Resources << /Font << /F1 ${font} 0 R >> >>`,
    'BT /F1 10 Tf 1 0 0 1 0 12 Tm (SECRET-AB) Tj ET',
  ); // 2
  const outer = b.addStream(
    `/Type /XObject /Subtype /Form /BBox [0 0 300 50] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /FmX ${inner} 0 R >> >>`,
    'BT /F1 10 Tf 1 0 0 1 0 12 Tm (OUTER) Tj ET\n1 0 0 1 0 -15 cm\n/FmX Do',
  ); // 3
  const content1 = b.addStream('', 'q 1 0 0 1 50 700 cm /FmX Do Q'); // 4
  const content2 = b.addStream('', 'q 1 0.2 0.3 1 300 600 cm /FmX Do Q'); // 5 (shear)
  const page1 = b.add(
    `<< /Type /Page /Parent 8 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /FmX ${outer} 0 R >> >> /Contents ${content1} 0 R >>`,
  ); // 6
  const page2 = b.add(
    `<< /Type /Page /Parent 8 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /FmX ${outer} 0 R >> >> /Contents ${content2} 0 R >>`,
  ); // 7
  b.add(`<< /Type /Pages /Kids [${page1} 0 R ${page2} 0 R] /Count 2 >>`); // 8
  const catalog = b.add('<< /Type /Catalog /Pages 8 0 R >>'); // 9
  return b.build(catalog);
}

// Page 1: inner text "SECRET-AB" glyphs at visible x = 50+6i, y in [87, 97].
// "SECRET" occupies x 50..86; the following "-" starts exactly at x = 86.
const SCENARIO1_REGIONS: RedactionRegion[] = [
  { page: 1, x: 50, y: 86, width: 36, height: 13 },
];

describe('shared nested form across pages', () => {
  const pdf = buildSharedFormPdf();

  it('preview hits only the targeted instance', () => {
    const hits = preview(pdf, SCENARIO1_REGIONS);
    expect(hits.map((h) => h.char).join('')).toBe('SECRET');
    expect(hits.every((h) => h.page === 1)).toBe(true);
    expect(hits).toHaveLength(6);
  });

  it('burnIn redacts one instance and keeps every other instance intact', () => {
    const out = burnIn(pdf, SCENARIO1_REGIONS);
    const text = extractText(parsePdf(out));
    expect(text[0]).toBe('OUTER-AB');
    expect(text[1]).toBe('OUTERSECRET-AB');
    expectKeptGlyphsPreserved(pdf, out, SCENARIO1_REGIONS);
    expectPreviewBurnInConsistent(pdf, SCENARIO1_REGIONS);
  });

  it('does not modify the source bytes', () => {
    const copy = new Uint8Array(pdf);
    burnIn(pdf, SCENARIO1_REGIONS);
    expect(Buffer.compare(Buffer.from(pdf), Buffer.from(copy))).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Scenario 2: rotated page, nonzero CropBox, escapes/hex/TJ, touching  */
/* ------------------------------------------------------------------ */

function buildRotatedPdf(): Uint8Array {
  const b = new PdfBuilder();
  const font = b.add(COURIER_FONT); // 1
  // Literal string with escapes: (A\)B\\C) -> A ) B \ C ; hex <444546> -> DEF
  const content = b.addStream(
    '',
    'BT /F1 12 Tf 1 0 0 1 150 250 Tm (A\\)B\\\\C) Tj <444546> Tj [ (G) 250 (H) -120 (IJ) ] TJ ET',
  ); // 2
  const page = b.add(
    `<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] /CropBox [100 100 400 500] /Rotate 90 /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
  ); // 3
  b.add(`<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`); // 4
  const catalog = b.add('<< /Type /Catalog /Pages 4 0 R >>'); // 5
  return b.build(catalog);
}

// Visible mapping (rotate 90, crop [100,100,400,500]): vx = y-100, vy = x-100.
// Glyph boxes: vx [147.6, 159.6]; glyph i vy = [50+7.2i, 57.2+7.2i] except
// after TJ adjustments: H at [111.8, 119], I at [120.44, 127.64], J at [127.64, 134.84].
const SCENARIO2_REGIONS: RedactionRegion[] = [
  { page: 1, x: 147, y: 57.2, width: 13, height: 7.2 }, // hits ')' exactly
  { page: 1, x: 147, y: 63, width: 13, height: 8.6 }, // overlaps previous, hits ')' and 'B'
  { page: 1, x: 148, y: 134.84, width: 10, height: 5 }, // only touches J's edge: no hit
  { page: 1, x: 148, y: 42.8, width: 10, height: 7.2 }, // only touches A's edge: no hit
  { page: 1, x: 147, y: 114.8, width: 13, height: 4.2 }, // hits 'H' (after TJ adjustments)
];

describe('rotated page with nonzero CropBox', () => {
  const pdf = buildRotatedPdf();

  it('computes visible-space quads with rotation and crop applied', () => {
    const glyphs = extractGlyphs(parsePdf(pdf));
    expect(glyphs.map((g) => g.char).join('')).toBe('A)B\\CDEFGHIJ');
    const a = glyphs[0]!;
    // 'A' quad: x 150..157.2, y 247.6..259.6 user -> vx 147.6..159.6, vy 50..57.2
    expect(a.quad[0]![0]).toBeCloseTo(147.6, 6);
    expect(a.quad[0]![1]).toBeCloseTo(50, 6);
    expect(a.quad[2]![0]).toBeCloseTo(159.6, 6);
    expect(a.quad[2]![1]).toBeCloseTo(57.2, 6);
    // 'H' sits after a +250 TJ adjustment: user x0 = 150 + 9*7.2 - 3 = 211.8
    const h = glyphs[9]!;
    expect(h.char).toBe('H');
    expect(h.quad[0]![1]).toBeCloseTo(111.8, 6);
    expect(h.quad[2]![1]).toBeCloseTo(119, 6);
    // 'I' sits after an additional -120 adjustment: user x0 = 220.44
    const i = glyphs[10]!;
    expect(i.quad[0]![1]).toBeCloseTo(120.44, 6);
  });

  it('preview hits overlapping regions once and ignores boundary-only contact', () => {
    const hits = preview(pdf, SCENARIO2_REGIONS);
    expect(hits.map((h) => h.char).join('')).toBe(')BH');
    expect(hits).toHaveLength(3);
  });

  it('burnIn removes hit glyphs and keeps positions of survivors', () => {
    const out = burnIn(pdf, SCENARIO2_REGIONS);
    const text = extractText(parsePdf(out));
    expect(text[0]).toBe('A\\CDEFGIJ');
    expectKeptGlyphsPreserved(pdf, out, SCENARIO2_REGIONS);
    expectPreviewBurnInConsistent(pdf, SCENARIO2_REGIONS);
  });
});

/* ------------------------------------------------------------------ */
/* Scenario 3: unique sensitive text, leak scan over all objects        */
/* ------------------------------------------------------------------ */

function buildSensitivePdf(compress: boolean): Uint8Array {
  const b = new PdfBuilder();
  const font = b.add(COURIER_FONT); // 1
  const content = b.addStream(
    '',
    'BT /F1 14 Tf 1 0 0 1 72 700 Tm (TOP-SECRET-12345) Tj ET\nBT /F1 14 Tf 1 0 0 1 72 650 Tm (public info) Tj ET',
    compress,
  ); // 2
  const page = b.add(
    `<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
  ); // 3
  b.add(`<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`); // 4
  const catalog = b.add('<< /Type /Catalog /Pages 4 0 R >>'); // 5
  return b.build(catalog);
}

const SCENARIO3_REGIONS: RedactionRegion[] = [
  { page: 1, x: 70, y: 79, width: 140, height: 18 },
];

function collectBytes(doc: PdfDocument): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  const visit = (obj: PdfObject): void => {
    switch (obj.kind) {
      case 'string':
        chunks.push(obj.bytes);
        break;
      case 'array':
        obj.items.forEach(visit);
        break;
      case 'dict':
        for (const [k, v] of obj.entries) {
          chunks.push(new Uint8Array([...k].map((c) => c.charCodeAt(0))));
          visit(v);
        }
        break;
      case 'stream':
        chunks.push(decodeStreamData(obj.dict, obj.data));
        for (const v of obj.dict.entries.values()) visit(v);
        break;
      case 'name':
        chunks.push(new Uint8Array([...obj.value].map((c) => c.charCodeAt(0))));
        break;
      default:
        break;
    }
  };
  for (const obj of doc.objects.values()) visit(obj);
  return chunks;
}

function containsHaystack(chunks: Uint8Array[], needle: string): boolean {
  const needleBytes = new Uint8Array([...needle].map((c) => c.charCodeAt(0)));
  return chunks.some((chunk) => {
    outer: for (let i = 0; i + needleBytes.length <= chunk.length; i++) {
      for (let j = 0; j < needleBytes.length; j++) {
        if (chunk[i + j] !== needleBytes[j]) continue outer;
      }
      return true;
    }
    return false;
  });
}

function reachableIds(doc: PdfDocument): Set<number> {
  const seen = new Set<number>();
  const visit = (obj: PdfObject): void => {
    if (obj.kind === 'ref') {
      if (seen.has(obj.obj)) return;
      seen.add(obj.obj);
      const target = doc.objects.get(obj.obj);
      if (target) visit(target);
    } else if (obj.kind === 'array') {
      obj.items.forEach(visit);
    } else if (obj.kind === 'dict') {
      for (const v of obj.entries.values()) visit(v);
    } else if (obj.kind === 'stream') {
      for (const v of obj.dict.entries.values()) visit(v);
    }
  };
  visit(doc.rootRef);
  return seen;
}

describe.each([false, true])('sensitive text removal (compress=%s)', (compress) => {
  const pdf = buildSensitivePdf(compress);

  it('removes the sensitive text so it cannot be extracted', () => {
    const out = burnIn(pdf, SCENARIO3_REGIONS);
    const text = extractText(parsePdf(out));
    expect(text[0]).toBe('public info');
    expect(text[0]).not.toContain('SECRET');
  });

  it('leaves no trace of the old text in any object, referenced or not', () => {
    const out = burnIn(pdf, SCENARIO3_REGIONS);
    const doc = parsePdf(out);
    const chunks = collectBytes(doc);
    expect(containsHaystack(chunks, 'TOP-SECRET-12345')).toBe(false);
    expect(containsHaystack(chunks, 'SECRET')).toBe(false);
    expect(containsHaystack(chunks, '12345')).toBe(false);
  });

  it('contains no unreferenced objects or incremental history', () => {
    const out = burnIn(pdf, SCENARIO3_REGIONS);
    const doc = parsePdf(out);
    expect(reachableIds(doc)).toEqual(new Set(doc.objects.keys()));
    const text = Buffer.from(out).toString('latin1');
    expect(text.match(/startxref/g)).toHaveLength(1);
    expect(text).not.toContain('%%EOF\nxref');
  });

  it('keeps survivor positions exact', () => {
    const out = burnIn(pdf, SCENARIO3_REGIONS);
    expectKeptGlyphsPreserved(pdf, out, SCENARIO3_REGIONS);
    expectPreviewBurnInConsistent(pdf, SCENARIO3_REGIONS);
  });
});

/* ------------------------------------------------------------------ */
/* Misc                                                                 */
/* ------------------------------------------------------------------ */

describe('no-hit burnIn', () => {
  it('returns a valid PDF with identical text', () => {
    const pdf = buildSensitivePdf(false);
    const out = burnIn(pdf, [{ page: 1, x: 500, y: 500, width: 10, height: 10 }]);
    expect(extractText(parsePdf(out))).toEqual(extractText(parsePdf(pdf)));
  });
});
