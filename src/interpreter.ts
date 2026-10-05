import { tokenizeContent, type ContentToken } from './contentStream';
import { IDENTITY, applyToPoint, multiply, translate, type Matrix } from './matrix';
import { decodeStreamData } from './pdfParser';
import {
  asName,
  asNumber,
  deref,
  dictGet,
  type PdfDocument,
  type PdfDict,
  type PdfObject,
  type PdfStream,
} from './pdfTypes';

/** Identifies one Do invocation site: the Do operator at `doTokenIndex` inside
 *  the content stream of object `streamObjId`, drawing form `formObjId`. */
export interface DoSite {
  streamObjId: number;
  doTokenIndex: number;
  formObjId: number;
}

/** One drawn glyph instance, in visible page coordinates. */
export interface GlyphInstance {
  /** 0-based page index in document order. */
  pageIndex: number;
  char: string;
  /** Four corners of the glyph hit box, in visible page coordinates. */
  quad: [number, number][];
  /** Do-invocation chain from the page content stream down to the innermost form. */
  path: DoSite[];
  /** Object id of the content stream that directly contains the text operator. */
  streamObjId: number;
  /** Token index of the Tj/TJ operator within that stream. */
  opTokenIndex: number;
  /** Glyph ordinal within the operator (counting across all strings of a TJ). */
  glyphOrdinal: number;
}

export interface PageInfo {
  objId: number;
  /** Object id of the single content stream. */
  contentsObjId: number;
  /** Effective CropBox [x0, y0, x1, y1] in default user space. */
  cropBox: [number, number, number, number];
  /** Effective /Rotate, normalized to 0, 90, 180 or 270. */
  rotate: number;
  /** Effective (dereferenced) resource dict. */
  resources: PdfDict;
}

interface InheritedPageAttrs {
  mediaBox?: [number, number, number, number];
  cropBox?: [number, number, number, number];
  rotate: number;
  resources?: PdfDict;
}

function readBox(doc: PdfDocument, obj: PdfObject | undefined): [number, number, number, number] | undefined {
  if (obj === undefined) return undefined;
  const o = deref(doc, obj);
  if (o.kind !== 'array' || o.items.length !== 4) return undefined;
  const vals = o.items.map((item) => asNumber(doc, item));
  if (vals.some((v) => v === undefined)) return undefined;
  return vals as [number, number, number, number];
}

function walkPageTree(
  doc: PdfDocument,
  nodeObj: PdfObject,
  inherited: InheritedPageAttrs,
  out: PageInfo[],
): void {
  const node = deref(doc, nodeObj);
  if (node.kind !== 'dict') throw new Error('page tree node is not a dict');
  const mediaBox = readBox(doc, node.entries.get('MediaBox')) ?? inherited.mediaBox;
  const cropBox = readBox(doc, node.entries.get('CropBox')) ?? inherited.cropBox ?? mediaBox;
  const rotateRaw = asNumber(doc, node.entries.get('Rotate'));
  const rotate = rotateRaw === undefined ? inherited.rotate : ((rotateRaw % 360) + 360) % 360;
  const resObj = dictGet(doc, node, 'Resources');
  const resources = resObj && resObj.kind === 'dict' ? resObj : inherited.resources;
  const type = asName(doc, node.entries.get('Type'));
  const kids = node.entries.get('Kids');
  if (type === 'Page' || kids === undefined) {
    if (!mediaBox || !cropBox) throw new Error('page without MediaBox/CropBox');
    if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) {
      throw new Error(`unsupported page rotation ${rotate}`);
    }
    if (!resources) throw new Error('page without resources');
    const contents = node.entries.get('Contents');
    if (!contents || contents.kind !== 'ref') {
      throw new Error('only a single indirect content stream per page is supported');
    }
    const nodeId = nodeObj.kind === 'ref' ? nodeObj.obj : -1;
    out.push({
      objId: nodeId,
      contentsObjId: contents.obj,
      cropBox,
      rotate,
      resources,
    });
    return;
  }
  const kidsArr = deref(doc, kids);
  if (kidsArr.kind !== 'array') throw new Error('/Kids is not an array');
  for (const kid of kidsArr.items) {
    walkPageTree(doc, kid, { mediaBox, cropBox, rotate, resources }, out);
  }
}

/** Walk the page tree and return pages in document order. */
export function listPages(doc: PdfDocument): PageInfo[] {
  const catalog = deref(doc, doc.rootRef);
  if (catalog.kind !== 'dict') throw new Error('catalog is not a dict');
  const pagesRef = catalog.entries.get('Pages');
  if (!pagesRef) throw new Error('catalog has no /Pages');
  const out: PageInfo[] = [];
  walkPageTree(doc, pagesRef, { rotate: 0 }, out);
  return out;
}

/** Matrix mapping default user space to visible page coordinates
 *  (origin at the top-left of the rotated CropBox, x right, y down). */
export function visibleMatrix(cropBox: [number, number, number, number], rotate: number): Matrix {
  const [x0, y0, x1, y1] = cropBox;
  switch (rotate) {
    case 0: return [1, 0, 0, -1, -x0, y1];
    case 90: return [0, 1, 1, 0, -y0, -x0];
    case 180: return [-1, 0, 0, 1, x1, -y0];
    case 270: return [0, -1, -1, 0, y1, x1];
    default: throw new Error(`unsupported rotation ${rotate}`);
  }
}

interface GraphicsState {
  ctm: Matrix;
  fontSize: number;
  tm: Matrix;
  tlm: Matrix;
  resources: PdfDict;
}

function readMatrix6(doc: PdfDocument, obj: PdfObject | undefined): Matrix | undefined {
  if (obj === undefined) return undefined;
  const o = deref(doc, obj);
  if (o.kind !== 'array' || o.items.length !== 6) return undefined;
  const vals = o.items.map((item) => asNumber(doc, item));
  if (vals.some((v) => v === undefined)) return undefined;
  return vals as unknown as Matrix;
}

const GLYPH_ADVANCE = 600; // Courier advance width in glyph space (1/1000 em)
const GLYPH_BOX = { x0: 0, y0: -200, x1: 600, y1: 800 }; // glyph space hit box

class Interpreter {
  glyphs: GlyphInstance[] = [];

  constructor(
    private doc: PdfDocument,
    private pageIndex: number,
    private visible: Matrix,
  ) {}

  run(streamObjId: number, state: GraphicsState, path: DoSite[]): void {
    const streamObj = this.doc.objects.get(streamObjId);
    if (!streamObj || streamObj.kind !== 'stream') {
      throw new Error(`object ${streamObjId} is not a stream`);
    }
    const tokens = tokenizeContent(decodeStreamData(streamObj.dict, streamObj.data));
    const ctmStack: Matrix[] = [];
    let operandStart = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.type !== 'operator') continue;
      const operands = tokens.slice(operandStart, i);
      operandStart = i + 1;
      switch (t.op) {
        case 'q':
          ctmStack.push(state.ctm);
          break;
        case 'Q':
          state.ctm = ctmStack.pop() ?? state.ctm;
          break;
        case 'cm': {
          const m = this.matrixOperand(operands);
          state.ctm = multiply(m, state.ctm);
          break;
        }
        case 'BT':
          state.tm = IDENTITY;
          state.tlm = IDENTITY;
          break;
        case 'ET':
          break;
        case 'Tf': {
          const size = operands[1];
          if (!size || size.type !== 'number') throw new Error('bad Tf operands');
          state.fontSize = size.value;
          break;
        }
        case 'Tm': {
          const m = this.matrixOperand(operands);
          state.tm = m;
          state.tlm = m;
          break;
        }
        case 'Td': {
          const tx = this.numberOperand(operands, 0);
          const ty = this.numberOperand(operands, 1);
          state.tlm = multiply(translate(tx, ty), state.tlm);
          state.tm = state.tlm;
          break;
        }
        case 'Tj': {
          const operand = operands[0];
          if (!operand || operand.type !== 'string') throw new Error('bad Tj operand');
          this.showString(operand.bytes, i, { n: 0 }, state, path, streamObjId);
          break;
        }
        case 'TJ': {
          const operand = operands[0];
          if (!operand || operand.type !== 'array') throw new Error('bad TJ operand');
          const ordinal = { n: 0 };
          for (const el of operand.elements) {
            if (el.type === 'string') {
              this.showString(el.bytes, i, ordinal, state, path, streamObjId);
            } else if (el.type === 'number') {
              const dx = (-el.value / 1000) * state.fontSize;
              state.tm = multiply(translate(dx, 0), state.tm);
            }
          }
          break;
        }
        case 'Do': {
          const operand = operands[0];
          if (!operand || operand.type !== 'name') throw new Error('bad Do operand');
          this.invokeForm(operand.name, i, state, path, streamObjId);
          break;
        }
        default:
          throw new Error(`unsupported content operator: ${t.op}`);
      }
    }
  }

  private matrixOperand(operands: ContentToken[]): Matrix {
    if (operands.length !== 6 || operands.some((o) => o.type !== 'number')) {
      throw new Error('expected 6 numeric operands');
    }
    return operands.map((o) => (o as { value: number }).value) as unknown as Matrix;
  }

  private numberOperand(operands: ContentToken[], index: number): number {
    const o = operands[index];
    if (!o || o.type !== 'number') throw new Error('expected numeric operand');
    return o.value;
  }

  private invokeForm(
    name: string,
    doTokenIndex: number,
    state: GraphicsState,
    path: DoSite[],
    streamObjId: number,
  ): void {
    const xobjects = dictGet(this.doc, state.resources, 'XObject');
    if (!xobjects || xobjects.kind !== 'dict') throw new Error('no /XObject in resources');
    const targetRef = xobjects.entries.get(name);
    if (!targetRef) throw new Error(`XObject /${name} not found`);
    if (targetRef.kind !== 'ref') throw new Error('XObject must be an indirect object');
    const target = deref(this.doc, targetRef);
    if (target.kind !== 'stream') throw new Error('XObject is not a stream');
    const subtype = asName(this.doc, target.dict.entries.get('Subtype'));
    if (subtype !== 'Form') throw new Error(`unsupported XObject subtype ${subtype} for /${name} (obj ${targetRef.obj})`);
    const matrix = readMatrix6(this.doc, target.dict.entries.get('Matrix')) ?? IDENTITY;
    const formResources = dictGet(this.doc, target.dict, 'Resources');

    const savedCtm = state.ctm;
    const savedResources = state.resources;
    state.ctm = multiply(matrix, state.ctm);
    if (formResources && formResources.kind === 'dict') state.resources = formResources;
    path.push({ streamObjId, doTokenIndex, formObjId: targetRef.obj });
    this.run(targetRef.obj, state, path);
    path.pop();
    state.ctm = savedCtm;
    state.resources = savedResources;
  }

  private showString(
    bytes: Uint8Array,
    opTokenIndex: number,
    ordinal: { n: number },
    state: GraphicsState,
    path: DoSite[],
    streamObjId: number,
  ): void {
    for (const byte of bytes) {
      const scale = state.fontSize / 1000;
      const quad: [number, number][] = [];
      for (const [gx, gy] of [
        [GLYPH_BOX.x0, GLYPH_BOX.y0],
        [GLYPH_BOX.x1, GLYPH_BOX.y0],
        [GLYPH_BOX.x1, GLYPH_BOX.y1],
        [GLYPH_BOX.x0, GLYPH_BOX.y1],
      ] as const) {
        const [ux, uy] = applyToPoint(state.tm, gx * scale, gy * scale);
        const [dx, dy] = applyToPoint(state.ctm, ux, uy);
        quad.push(applyToPoint(this.visible, dx, dy));
      }
      this.glyphs.push({
        pageIndex: this.pageIndex,
        char: String.fromCharCode(byte),
        quad,
        path: path.map((p) => ({ ...p })),
        streamObjId,
        opTokenIndex,
        glyphOrdinal: ordinal.n++,
      });
      state.tm = multiply(translate(GLYPH_ADVANCE * scale, 0), state.tm);
    }
  }
}

/** Interpret all content streams and return every drawn glyph instance with
 *  its visible-space hit quad and its full Do-invocation path. */
export function extractGlyphs(doc: PdfDocument): GlyphInstance[] {
  const pages = listPages(doc);
  const glyphs: GlyphInstance[] = [];
  pages.forEach((page, pageIndex) => {
    const interpreter = new Interpreter(doc, pageIndex, visibleMatrix(page.cropBox, page.rotate));
    const state: GraphicsState = {
      ctm: IDENTITY,
      fontSize: 0,
      tm: IDENTITY,
      tlm: IDENTITY,
      resources: page.resources,
    };
    interpreter.run(page.contentsObjId, state, []);
    glyphs.push(...interpreter.glyphs);
  });
  return glyphs;
}

/** Convenience for tests: concatenated text per page, in drawing order. */
export function extractText(doc: PdfDocument): string[] {
  const pages: string[] = [];
  for (const g of extractGlyphs(doc)) {
    while (pages.length <= g.pageIndex) pages.push('');
    pages[g.pageIndex] += g.char;
  }
  return pages;
}

export function getStream(doc: PdfDocument, objId: number): PdfStream {
  const obj = doc.objects.get(objId);
  if (!obj || obj.kind !== 'stream') throw new Error(`object ${objId} is not a stream`);
  return obj;
}

