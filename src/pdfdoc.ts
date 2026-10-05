/** Thin helpers over pdf-lib: page boxes/rotation, resource inheritance,
 *  form XObject access, stream replacement and garbage collection. */
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFArray,
  PDFRef,
  PDFStream,
  PDFRawStream,
  PDFObject,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import { IDENTITY } from './matrix';
import { Matrix } from './types';

export interface PageInfo {
  index: number;
  leaf: import('@cantoo/pdf-lib').PDFPageLeaf;
  contents: PDFStream;
  contentsRef: PDFRef | null;
  resources: PDFDict | null;
  /** Maps PDF user space -> view coordinates (top-left origin, y down). */
  viewMatrix: Matrix;
}

/** Decoded (uncompressed) contents of a stream object. */
export function streamContents(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) {
    return decodePDFRawStream(stream).decode();
  }
  return stream.getContents();
}

export function loadDocument(bytes: Uint8Array): Promise<PDFDocument> {
  // updateMetadata:false -> do not add Producer/ModDate to the output.
  return PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
}

export function getPageInfos(doc: PDFDocument): PageInfo[] {
  const infos: PageInfo[] = [];
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const leaf = page.node;
    const contentsRaw = leaf.Contents();
    if (!contentsRaw || contentsRaw instanceof PDFArray) {
      throw new Error('expected exactly one content stream per page');
    }
    const contentsRefRaw = leaf.get(PDFName.of('Contents'));
    const contentsRef = contentsRefRaw instanceof PDFRef ? contentsRefRaw : null;
    const resources = leaf.Resources() ?? null;
    const crop = page.getCropBox();
    const media = page.getMediaBox();
    const box = {
      x0: crop ? crop.x : media.x,
      y0: crop ? crop.y : media.y,
      x1: crop ? crop.x + crop.width : media.x + media.width,
      y1: crop ? crop.y + crop.height : media.y + media.height,
    };
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    let viewMatrix: Matrix;
    switch (angle) {
      case 0:
        viewMatrix = [1, 0, 0, -1, -box.x0, box.y1];
        break;
      case 90:
        viewMatrix = [0, 1, 1, 0, -box.y0, -box.x0];
        break;
      case 180:
        viewMatrix = [-1, 0, 0, 1, box.x1, -box.y0];
        break;
      case 270:
        viewMatrix = [0, -1, -1, 0, box.y1, box.x1];
        break;
      default:
        throw new Error(`unsupported page rotation: ${angle}`);
    }
    infos.push({
      index: i,
      leaf,
      contents: contentsRaw,
      contentsRef,
      resources,
      viewMatrix,
    });
  }
  return infos;
}

export interface FormInfo {
  stream: PDFRawStream;
  ref: PDFRef | null;
  matrix: Matrix;
  resources: PDFDict | null;
}

/** Resolve an XObject name in a resource dict; returns null if absent/not a form. */
export function resolveForm(resources: PDFDict | null, name: string): FormInfo | null {
  if (!resources) return null;
  const xobject = resources.lookup(PDFName.of('XObject'));
  if (!(xobject instanceof PDFDict)) return null;
  const target = xobject.lookup(PDFName.of(name));
  if (!(target instanceof PDFRawStream)) return null;
  const subtype = target.dict.lookup(PDFName.of('Subtype'));
  if (!(subtype instanceof PDFName) || subtype.asString() !== '/Form') return null;
  const matrixEntry = target.dict.lookup(PDFName.of('Matrix'));
  let matrix = IDENTITY;
  if (matrixEntry instanceof PDFArray) {
    const nums: number[] = [];
    for (let i = 0; i < 6; i++) {
      const el = matrixEntry.lookup(i);
      if (!(el instanceof PDFNumber)) throw new Error('bad form Matrix');
      nums.push(el.asNumber());
    }
    matrix = nums as Matrix;
  }
  const resEntry = target.dict.lookup(PDFName.of('Resources'));
  const refRaw = xobject.get(PDFName.of(name));
  return {
    stream: target,
    ref: refRaw instanceof PDFRef ? refRaw : null,
    matrix,
    resources: resEntry instanceof PDFDict ? resEntry : null,
  };
}

/** Clone a stream object with new (uncompressed) contents; dict entries are
 *  copied except Length/Filter. Returns the registered new object. */
export function cloneStreamWithContents(
  doc: PDFDocument,
  old: PDFStream,
  contents: Uint8Array,
): { ref: PDFRef; stream: PDFRawStream } {
  const ctx = doc.context;
  const raw = ctx.stream(contents);
  for (const [key, value] of old.dict.entries()) {
    const k = key.asString();
    if (k === '/Length' || k === '/Filter' || k === '/DecodeParms') continue;
    raw.dict.set(key, value);
  }
  const ref = ctx.register(raw);
  return { ref, stream: raw };
}

/** Remove objects unreachable from the trailer (no unreferenced leftovers). */
export function collectGarbage(doc: PDFDocument): void {
  const ctx = doc.context;
  const reachable = new Set<string>();
  const stack: PDFObject[] = [];
  const push = (obj: PDFObject | undefined) => {
    if (obj !== undefined) stack.push(obj);
  };
  push(ctx.trailerInfo.Root);
  push(ctx.trailerInfo.Info);
  while (stack.length > 0) {
    const obj = stack.pop()!;
    if (obj instanceof PDFRef) {
      const tag = obj.toString();
      if (reachable.has(tag)) continue;
      reachable.add(tag);
      const resolved = ctx.lookup(obj);
      if (resolved !== undefined) stack.push(resolved);
      continue;
    }
    if (obj instanceof PDFStream) {
      for (const [, value] of obj.dict.entries()) stack.push(value);
      continue;
    }
    if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) stack.push(value);
      continue;
    }
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i));
      continue;
    }
  }
  const doomed: PDFRef[] = [];
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.toString())) doomed.push(ref);
  }
  for (const ref of doomed) ctx.delete(ref);
}
