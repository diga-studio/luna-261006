import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import { burnIn, collectAllGlyphs, preview } from '../src/index';
import { Region } from '../src/types';
import { GlyphInstance } from '../src/walker';
import { PdfBuilder, pageTexts } from './helpers';

function bboxOf(glyphs: GlyphInstance[]): Region {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const g of glyphs) {
    for (const p of g.quad) {
      xs.push(p.x);
      ys.push(p.y);
    }
  }
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { page: glyphs[0]!.page, x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
}

/** Nested form (inner inside outer) shared by two pages with different
 *  matrices; page-level /Fm1 shadows the outer form's own /Fm1. */
async function buildSharedFormPdf(): Promise<Uint8Array> {
  const b = await PdfBuilder.create();
  const inner = b.addForm({
    contents: 'BT /F1 10 Tf 1 0 0 1 0 0 Tm (SECRET-INNER) Tj ET',
    bbox: [0, 0, 200, 50],
    resources: b.resources({ font: true }),
  });
  const outer = b.addForm({
    contents:
      'q 1 0 0 1 0 0 cm /Fm1 Do Q\n' +
      'BT /F1 10 Tf 1 0 0 1 0 12 Tm (OUTER-TEXT) Tj ET',
    bbox: [0, 0, 300, 100],
    resources: b.resources({ font: true, xobjects: { Fm1: inner } }),
  });
  // page 1: plain translation; /Fm1 here means the OUTER form (shadowing).
  b.addPage({
    size: [612, 792],
    contents: 'q 1 0 0 1 100 600 cm /Fm1 Do Q',
    resources: b.resources({ font: true, xobjects: { Fm1: outer } }),
  });
  // page 2: rotation + shear + non-uniform scale, same shared outer form.
  b.addPage({
    size: [612, 792],
    contents: 'q 0 0.5 -0.4 0.2 50 100 cm /Fm1 Do Q',
    resources: b.resources({ font: true, xobjects: { Fm1: outer } }),
  });
  return b.save();
}

test('shared nested form: redact one instance, others untouched', async () => {
  const pdf = await buildSharedFormPdf();
  const glyphs = await collectAllGlyphs(pdf);
  assert.equal(pageTexts(glyphs)[0], 'SECRET-INNEROUTER-TEXT');
  assert.equal(pageTexts(glyphs)[1], 'SECRET-INNEROUTER-TEXT');

  // target: glyphs 1..3 ("ECR") of SECRET-INNER on page 0 only
  const page0Inner = glyphs.filter((g) => g.page === 0 && g.doPath.length === 2);
  assert.equal(page0Inner.map((g) => g.char).join(''), 'SECRET-INNER');
  const targets = page0Inner.slice(1, 4);
  const region = bboxOf(targets);

  const hits = await preview(pdf, [region]);
  assert.equal(hits.length, 3);
  assert.ok(hits.every((h) => h.page === 0));

  const out = await burnIn(pdf, [region]);
  const outGlyphs = await collectAllGlyphs(out);
  const texts = pageTexts(outGlyphs);
  assert.equal(texts[0], 'SET-INNEROUTER-TEXT');
  assert.equal(texts[1], 'SECRET-INNEROUTER-TEXT');

  // every surviving glyph must sit exactly where it was (<= 0.01pt)
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  const matchGlyph = (g: GlyphInstance, pool: GlyphInstance[]) =>
    pool.some(
      (p) =>
        p.page === g.page &&
        p.char === g.char &&
        p.quad.every((pt, i) => close(pt.x, g.quad[i]!.x) && close(pt.y, g.quad[i]!.y)),
    );
  for (const g of outGlyphs) {
    assert.ok(matchGlyph(g, glyphs), `glyph ${g.char} moved or appeared unexpectedly`);
  }
  // and exactly the 3 target glyphs are gone
  const removed = glyphs.filter((g) => !matchGlyph(g, outGlyphs));
  assert.deepEqual(removed.map((g) => g.char).join(''), 'ECR');
});

/** Rotated page (90deg) with nonzero CropBox; escaped literals, hex strings,
 *  TJ arrays with positive/negative kerning. */
async function buildRotatedPdf(): Promise<Uint8Array> {
  const b = await PdfBuilder.create();
  b.addPage({
    size: [612, 792],
    cropBox: [50, 60, 562, 732],
    rotate: 90,
    contents:
      'BT /F1 12 Tf 1 0 0 1 100 500 Tm (A\\)B\\\\C) Tj ET\n' +
      'BT /F1 12 Tf 1 0 0 1 100 480 Tm <444546> Tj ET\n' +
      'BT /F1 12 Tf 1 0 0 1 100 460 Tm [(GH) -250 (I) 150 (JK)] TJ ET',
    resources: b.resources({ font: true }),
  });
  return b.save();
}

function findGlyph(glyphs: GlyphInstance[], page: number, char: string, occurrence = 0): GlyphInstance {
  const found = glyphs.filter((g) => g.page === page && g.char === char);
  const g = found[occurrence];
  if (!g) throw new Error(`glyph ${char}#${occurrence} not found`);
  return g;
}

function regionOfQuad(g: GlyphInstance): Region {
  return bboxOf([g]);
}

test('rotated page with cropbox: escapes, hex, TJ kerning, boundary rules', async () => {
  const pdf = await buildRotatedPdf();
  const glyphs = await collectAllGlyphs(pdf);
  assert.equal(pageTexts(glyphs)[0], 'A)B\\CDEFGHIJK');

  const gB = findGlyph(glyphs, 0, 'B');
  const gBackslash = findGlyph(glyphs, 0, '\\');
  const gE = findGlyph(glyphs, 0, 'E');
  const gH = findGlyph(glyphs, 0, 'H');

  // region exactly on B's quad: neighbours share only an edge -> not hit
  const rB = regionOfQuad(gB);
  // zero-area-overlap region touching B's edge (text runs down the rotated
  // view, so the next glyph is below); overlaps only the backslash glyph
  const rTouch: Region = {
    page: 0,
    x: rB.x,
    y: rB.y + rB.height,
    width: rB.width,
    height: 1,
  };
  // two overlapping regions both covering E (dedupe check)
  const rE = regionOfQuad(gE);
  const rE1: Region = { ...rE, width: rE.width / 2 + 0.5 };
  const rE2: Region = { ...rE, x: rE.x + rE.width / 2 - 0.5 };
  // region on H (TJ kerning gap around it)
  const rH = regionOfQuad(gH);

  const regions = [rB, rTouch, rE1, rE2, rH];
  const hits = await preview(pdf, regions);
  const hitChars = hits.map((h) => {
    // identify by quad match
    const g = glyphs.find(
      (cand) =>
        cand.page === h.page &&
        cand.quad.every((p, i) => Math.abs(p.x - h.quad[i]!.x) < 1e-6 && Math.abs(p.y - h.quad[i]!.y) < 1e-6),
    );
    return g?.char;
  });
  assert.deepEqual([...hitChars].sort(), ['B', 'E', 'H', '\\'].sort());
  // dedupe: E covered by two overlapping regions counts once
  assert.equal(hitChars.filter((c) => c === 'E').length, 1);

  const before = glyphs;
  const out = await burnIn(pdf, regions);
  const after = await collectAllGlyphs(out);
  assert.equal(pageTexts(after)[0], 'A)CDFGIJK');

  // kept glyphs keep their exact positions (<= 0.01pt), incl. after TJ kerning
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  for (const g of after) {
    const orig = before.find(
      (cand) =>
        cand.page === g.page &&
        cand.char === g.char &&
        cand.quad.every((p, i) => close(p.x, g.quad[i]!.x) && close(p.y, g.quad[i]!.y)),
    );
    assert.ok(orig, `glyph ${g.char} moved beyond tolerance`);
  }
  assert.equal(before.length - after.length, 4);
});

/** Collect the decoded contents of every stream object in a document. */
async function allStreamData(pdf: Uint8Array): Promise<Uint8Array[]> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const out: Uint8Array[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      out.push(decodePDFRawStream(obj).decode());
    }
  }
  return out;
}

/** Collect every string object (literal/hex) reachable or not. */
async function allStringObjects(pdf: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const out: string[] = [];
  const visit = (obj: PDFObject | undefined, depth: number): void => {
    if (!obj || depth > 20) return;
    if (obj instanceof PDFString || obj instanceof PDFHexString) {
      out.push(obj.asString());
    } else if (obj instanceof PDFStream) {
      for (const [, v] of obj.dict.entries()) visit(v, depth + 1);
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) visit(v, depth + 1);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) visit(obj.get(i), depth + 1);
    }
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) visit(obj, 0);
  return out;
}

/** Count objects reachable from the trailer; must equal total object count
 *  (i.e. no unreferenced leftovers). */
async function unreachableObjectCount(pdf: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const ctx = doc.context;
  const reachable = new Set<string>();
  const stack: PDFObject[] = [];
  if (ctx.trailerInfo.Root) stack.push(ctx.trailerInfo.Root);
  if (ctx.trailerInfo.Info) stack.push(ctx.trailerInfo.Info);
  while (stack.length > 0) {
    const obj = stack.pop()!;
    if (obj instanceof PDFRef) {
      const tag = obj.toString();
      if (reachable.has(tag)) continue;
      reachable.add(tag);
      const resolved = ctx.lookup(obj);
      if (resolved) stack.push(resolved);
    } else if (obj instanceof PDFStream) {
      for (const [, v] of obj.dict.entries()) stack.push(v);
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) stack.push(v);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i));
    }
  }
  const total = ctx.enumerateIndirectObjects().length;
  return total - reachable.size;
}

test('burn-in truly removes unique sensitive text; nothing hides anywhere', async () => {
  const b = await PdfBuilder.create();
  const secret = 'TOPSECRET-4711';
  b.addPage({
    size: [612, 792],
    contents:
      `BT /F1 12 Tf 1 0 0 1 72 700 Tm (hello ) Tj (${secret}) Tj ( world) Tj ET\n` +
      'BT /F1 12 Tf 1 0 0 1 72 660 Tm (nothing secret here) Tj ET',
    resources: b.resources({ font: true }),
  });
  const pdf = await b.save();
  const pdfCopy = new Uint8Array(pdf); // to verify input is not mutated

  const glyphs = await collectAllGlyphs(pdf);
  const secretGlyphs = glyphs.filter((g) => g.showOpIndex === 1);
  assert.equal(secretGlyphs.map((g) => g.char).join(''), secret);
  const region = bboxOf(secretGlyphs);

  const hits = await preview(pdf, [region]);
  assert.equal(hits.length, secret.length);

  const out = await burnIn(pdf, [region]);

  // input bytes untouched
  assert.deepEqual([...pdf], [...pdfCopy]);

  // page text no longer contains the secret
  const outGlyphs = await collectAllGlyphs(out);
  const text = pageTexts(outGlyphs)[0]!;
  assert.ok(!text.includes(secret), 'secret still extractable from page');
  assert.equal(text, 'hello  worldnothing secret here');

  // ' world' must start exactly where it did (advance of removed glyphs kept)
  const wBefore = glyphs.find((g) => g.char === 'w')!;
  const wAfter = outGlyphs.find((g) => g.char === 'w')!;
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(wBefore.quad[i]!.x - wAfter.quad[i]!.x) <= 0.01);
    assert.ok(Math.abs(wBefore.quad[i]!.y - wAfter.quad[i]!.y) <= 0.01);
  }

  // the secret must not hide in any stream (decoded) or string object
  const needle = new TextEncoder().encode(secret);
  for (const data of await allStreamData(out)) {
    outer: for (let i = 0; i + needle.length <= data.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (data[i + j] !== needle[j]) continue outer;
      }
      assert.fail('secret found inside a stream object');
    }
  }
  for (const s of await allStringObjects(out)) {
    assert.ok(!s.includes(secret), 'secret found in a string object');
  }

  // no unreferenced objects may remain in the output
  assert.equal(await unreachableObjectCount(out), 0);
});

test('rotations 180/270 and Td: absolute view coordinates are correct', async () => {
  const b = await PdfBuilder.create();
  // rotate 180, full-page crop: text at user (100,700), fs 10
  b.addPage({
    size: [612, 792],
    rotate: 180,
    contents: 'BT /F1 10 Tf 1 0 0 1 100 700 Tm (AB) Tj 12 0 Td (CD) Tj ET',
    resources: b.resources({ font: true }),
  });
  // rotate 270
  b.addPage({
    size: [612, 792],
    rotate: 270,
    contents: 'BT /F1 10 Tf 1 0 0 1 100 700 Tm (EF) Tj ET',
    resources: b.resources({ font: true }),
  });
  const pdf = await b.save();
  const glyphs = await collectAllGlyphs(pdf);

  // rotate 180: X = 612 - px, Y = py. Glyph 'A' hit box user x 100..106,
  // y 698..708 -> view x 506..512, y 698..708
  const gA = findGlyph(glyphs, 0, 'A');
  const xsA = gA.quad.map((p) => p.x);
  const ysA = gA.quad.map((p) => p.y);
  assert.ok(Math.abs(Math.min(...xsA) - 506) < 1e-6);
  assert.ok(Math.abs(Math.max(...xsA) - 512) < 1e-6);
  assert.ok(Math.abs(Math.min(...ysA) - 698) < 1e-6);
  assert.ok(Math.abs(Math.max(...ysA) - 708) < 1e-6);

  // Td moves relative to the line start (100), not the advanced text
  // matrix: 'C' sits at user x 112..118
  const gC = findGlyph(glyphs, 0, 'C');
  const xsC = gC.quad.map((p) => p.x);
  assert.ok(Math.abs(Math.min(...xsC) - (612 - 118)) < 1e-6);

  // rotate 270: X = 792 - py, Y = 612 - px. Glyph 'E': user x 100..106,
  // y 698..708 -> view x 84..94, y 506..512
  const gE = findGlyph(glyphs, 1, 'E');
  const xsE = gE.quad.map((p) => p.x);
  const ysE = gE.quad.map((p) => p.y);
  assert.ok(Math.abs(Math.min(...xsE) - 84) < 1e-6);
  assert.ok(Math.abs(Math.max(...xsE) - 94) < 1e-6);
  assert.ok(Math.abs(Math.min(...ysE) - 506) < 1e-6);
  assert.ok(Math.abs(Math.max(...ysE) - 512) < 1e-6);

  // redact 'C' on page 0 and 'F' on page 1; survivors must not move
  const regions = [regionOfQuad(gC), regionOfQuad(findGlyph(glyphs, 1, 'F'))];
  const hits = await preview(pdf, regions);
  assert.equal(hits.length, 2);
  const out = await burnIn(pdf, regions);
  const after = await collectAllGlyphs(out);
  assert.equal(pageTexts(after)[0], 'ABD');
  assert.equal(pageTexts(after)[1], 'E');
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  for (const g of after) {
    const orig = glyphs.find(
      (cand) =>
        cand.page === g.page &&
        cand.char === g.char &&
        cand.quad.every((p, i) => close(p.x, g.quad[i]!.x) && close(p.y, g.quad[i]!.y)),
    );
    assert.ok(orig, `glyph ${g.char} moved`);
  }
});

test('same resource-less form drawn twice on one page: clone only one instance', async () => {
  const b = await PdfBuilder.create();
  // form without its own Resources: inherits the page's resource dict
  const form = b.addForm({
    contents: 'BT /F1 10 Tf 1 0 0 1 0 0 Tm (REPEATME) Tj ET',
    bbox: [0, 0, 100, 20],
  });
  b.addPage({
    size: [612, 792],
    contents: 'q 1 0 0 1 100 500 cm /Fm Do Q\nq 1 0 0 1 100 300 cm /Fm Do Q',
    resources: b.resources({ font: true, xobjects: { Fm: form } }),
    compress: false, // also exercise uncompressed content streams
  });
  const pdf = await b.save();
  const glyphs = await collectAllGlyphs(pdf);
  assert.equal(pageTexts(glyphs)[0], 'REPEATMEREPEATME');

  // hit glyph index 1 ('E') of the SECOND instance only (doPath [1])
  const second = glyphs.filter((g) => g.doPath.length === 1 && g.doPath[0] === 1);
  assert.equal(second.map((g) => g.char).join(''), 'REPEATME');
  const region = bboxOf([second[1]!]);

  const hits = await preview(pdf, [region]);
  assert.equal(hits.length, 1);

  const out = await burnIn(pdf, [region]);
  const outGlyphs = await collectAllGlyphs(out);
  assert.equal(pageTexts(outGlyphs)[0], 'REPEATMERPEATME');

  // first instance intact, second lost exactly one 'E'
  const first = outGlyphs.filter((g) => g.doPath.length === 1 && g.doPath[0] === 0);
  const snd = outGlyphs.filter((g) => g.doPath.length === 1 && g.doPath[0] === 1);
  assert.equal(first.map((g) => g.char).join(''), 'REPEATME');
  assert.equal(snd.map((g) => g.char).join(''), 'RPEATME');

  // kept glyphs of the second instance did not move
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  for (const g of snd) {
    const orig = second.find(
      (cand) =>
        cand.char === g.char &&
        cand.quad.every((p, i) => close(p.x, g.quad[i]!.x) && close(p.y, g.quad[i]!.y)),
    );
    assert.ok(orig, `glyph ${g.char} moved`);
  }

  // re-running preview on the output hits nothing (hit set is exactly gone)
  const rehits = await preview(out, [region]);
  assert.equal(rehits.length, 0);

  assert.equal(await unreachableObjectCount(out), 0);
});
