/** Geometry traversal: walks page content streams and nested form XObjects,
 *  computing the view-space quad of every drawn glyph instance. */
import { PDFDict, PDFDocument, PDFStream } from '@cantoo/pdf-lib';
import { parseContentStream } from './content';
import { IDENTITY, multiply, translate, applyToPoint } from './matrix';
import { PageInfo, resolveForm } from './pdfdoc';
import { streamContents } from './pdfdoc';
import { Matrix, Point } from './types';

/** Identifies one drawn glyph instance. */
export interface GlyphInstance {
  page: number;
  /** Do-invocation path from the page stream to the containing stream. */
  doPath: number[];
  /** Index of the show operator (Tj/TJ) within its stream. */
  showOpIndex: number;
  /** Glyph index within the show operator. */
  glyphIndex: number;
  char: string;
  quad: [Point, Point, Point, Point];
}

/** Courier advance width and hit box in glyph space (1/1000 em). */
const GLYPH_ADVANCE = 600;
const HIT_X0 = 0;
const HIT_X1 = 600;
const HIT_Y0 = -200;
const HIT_Y1 = 800;

interface WalkState {
  ctm: Matrix;
  tm: Matrix;
  tlm: Matrix;
  fontSize: number;
  stack: Matrix[];
}

class Walker {
  constructor(
    private page: PageInfo,
    private out: GlyphInstance[],
  ) {}

  walk(stream: PDFStream, resources: PDFDict | null, doPath: number[], ctm: Matrix): void {
    const ops = parseContentStream(streamContents(stream));
    const state: WalkState = {
      ctm,
      tm: IDENTITY,
      tlm: IDENTITY,
      fontSize: 0,
      stack: [],
    };
    let showOpIndex = 0;
    let doIndex = 0;
    const viewCtm = () => multiply(this.page.viewMatrix, state.ctm);

    const showString = (bytes: number[]) => {
      const scale = state.fontSize / 1000;
      for (const byte of bytes) {
        const m = multiply(viewCtm(), state.tm);
        const corner = (gx: number, gy: number): Point =>
          applyToPoint(m, { x: gx * scale, y: gy * scale });
        this.out.push({
          page: this.page.index,
          doPath: [...doPath],
          showOpIndex,
          glyphIndex: -1, // set by caller loop below
          char: String.fromCharCode(byte),
          quad: [
            corner(HIT_X0, HIT_Y0),
            corner(HIT_X1, HIT_Y0),
            corner(HIT_X1, HIT_Y1),
            corner(HIT_X0, HIT_Y1),
          ],
        });
        state.tm = multiply(state.tm, translate(GLYPH_ADVANCE * scale, 0));
      }
    };

    for (const op of ops) {
      switch (op.name) {
        case 'q':
          state.stack.push(state.ctm);
          break;
        case 'Q':
          state.ctm = state.stack.pop() ?? IDENTITY;
          break;
        case 'cm':
          state.ctm = multiply(state.ctm, matrixOf(op.operands));
          break;
        case 'BT':
          state.tm = IDENTITY;
          state.tlm = IDENTITY;
          break;
        case 'ET':
          break;
        case 'Tf':
          state.fontSize = numberAt(op.operands, 1);
          break;
        case 'Tm': {
          const m = matrixOf(op.operands);
          state.tm = m;
          state.tlm = m;
          break;
        }
        case 'Td': {
          const tx = numberAt(op.operands, 0);
          const ty = numberAt(op.operands, 1);
          state.tlm = multiply(state.tlm, translate(tx, ty));
          state.tm = state.tlm;
          break;
        }
        case 'Tj': {
          const str = op.operands[0];
          if (str?.kind !== 'string') throw new Error('Tj without string');
          const before = this.out.length;
          showString(str.bytes);
          for (let i = before; i < this.out.length; i++) {
            this.out[i]!.glyphIndex = i - before;
          }
          showOpIndex++;
          break;
        }
        case 'TJ': {
          const arr = op.operands[0];
          if (arr?.kind !== 'array') throw new Error('TJ without array');
          let glyphIndex = 0;
          for (const item of arr.items) {
            if (item.kind === 'number') {
              const t = (-item.value / 1000) * state.fontSize;
              state.tm = multiply(state.tm, translate(t, 0));
            } else {
              const before = this.out.length;
              showString(item.bytes);
              for (let i = before; i < this.out.length; i++) {
                this.out[i]!.glyphIndex = glyphIndex++;
              }
            }
          }
          showOpIndex++;
          break;
        }
        case 'Do': {
          const nameOp = op.operands[0];
          if (nameOp?.kind !== 'name') throw new Error('Do without name');
          const form = resolveForm(resources, nameOp.value);
          if (form) {
            const childCtm = multiply(state.ctm, form.matrix);
            this.walk(form.stream, form.resources ?? resources, [...doPath, doIndex], childCtm);
          }
          doIndex++;
          break;
        }
        default:
          throw new Error(`unsupported operator: ${op.name}`);
      }
    }
  }
}

function numberAt(operands: { kind: string; value?: unknown }[], i: number): number {
  const op = operands[i];
  if (!op || op.kind !== 'number') throw new Error('expected number operand');
  return op.value as number;
}

function matrixOf(operands: { kind: string; value?: unknown }[]): Matrix {
  const nums: number[] = [];
  for (let i = 0; i < 6; i++) nums.push(numberAt(operands, i));
  return nums as Matrix;
}

export function collectGlyphs(doc: PDFDocument, pages: PageInfo[]): GlyphInstance[] {
  const out: GlyphInstance[] = [];
  for (const page of pages) {
    new Walker(page, out).walk(page.contents, page.resources, [], IDENTITY);
  }
  return out;
}
