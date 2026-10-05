/** Builders for real PDF files exercising forms, nesting, rotations, etc. */
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFRef,
  StandardFonts,
} from '@cantoo/pdf-lib';

export interface FormSpec {
  contents: string;
  bbox: number[];
  matrix?: number[];
  resources?: PDFDict;
}

export class PdfBuilder {
  private constructor(public doc: PDFDocument, public fontRef: PDFRef) {}

  static async create(): Promise<PdfBuilder> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = doc.embedStandardFont(StandardFonts.Courier);
    return new PdfBuilder(doc, font.ref as PDFRef);
  }

  fontDict(): PDFDict {
    return this.doc.context.obj({ F1: this.fontRef }) as PDFDict;
  }

  resources(opts: { font?: boolean; xobjects?: Record<string, PDFRef> }): PDFDict {
    const res = this.doc.context.obj({}) as PDFDict;
    if (opts.font) res.set(PDFName.of('Font'), this.fontDict());
    if (opts.xobjects) {
      res.set(PDFName.of('XObject'), this.doc.context.obj(opts.xobjects) as PDFDict);
    }
    return res;
  }

  addForm(spec: FormSpec): PDFRef {
    const stream = this.doc.context.stream(new TextEncoder().encode(spec.contents));
    stream.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
    stream.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
    stream.dict.set(PDFName.of('BBox'), this.doc.context.obj(spec.bbox));
    if (spec.matrix) {
      stream.dict.set(PDFName.of('Matrix'), this.doc.context.obj(spec.matrix));
    }
    if (spec.resources) stream.dict.set(PDFName.of('Resources'), spec.resources);
    return this.doc.context.register(stream);
  }

  addPage(opts: {
    size: [number, number];
    contents: string;
    resources: PDFDict;
    cropBox?: number[];
    rotate?: number;
    compress?: boolean;
  }): void {
    const page = this.doc.addPage(opts.size);
    page.node.set(PDFName.of('Resources'), opts.resources);
    if (opts.cropBox) {
      page.node.set(PDFName.of('CropBox'), this.doc.context.obj(opts.cropBox));
    }
    if (opts.rotate !== undefined) {
      page.node.set(PDFName.of('Rotate'), this.doc.context.obj(opts.rotate));
    }
    const bytes = new TextEncoder().encode(opts.contents);
    const stream = opts.compress === false
      ? this.doc.context.stream(bytes)
      : this.doc.context.flateStream(bytes);
    page.node.set(PDFName.of('Contents'), this.doc.context.register(stream));
  }

  save(): Promise<Uint8Array> {
    return this.doc.save({ useObjectStreams: false });
  }
}

/** Extract per-page visible text (chars in draw order) from glyph instances. */
export function pageTexts(glyphs: Array<{ page: number; char: string }>): string[] {
  const out: string[] = [];
  for (const g of glyphs) {
    out[g.page] = (out[g.page] ?? '') + g.char;
  }
  return out;
}
