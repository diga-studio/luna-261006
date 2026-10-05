import {
  arrayToken,
  literalStringToken,
  nameToken,
  numberToken,
  serializeTokens,
  tokenizeContent,
  type ContentToken,
} from './contentStream';
import { quadRectIntersectionArea, type Quad, type Rect } from './geometry';
import { extractGlyphs, getStream, listPages, type GlyphInstance } from './interpreter';
import { decodeStreamData, parsePdf } from './pdfParser';
import {
  deref,
  dict,
  ref,
  type PdfDict,
  type PdfDocument,
  type PdfObject,
  type PdfStream,
} from './pdfTypes';
import { serializePdf } from './pdfWriter';

/** A redaction region: 1-based page number plus a rectangle in visible page
 *  coordinates (origin at the top-left of the rotated, cropped page, x right,
 *  y down, unit pt). */
export interface RedactionRegion extends Rect {
  page: number;
}

/** One glyph hit by a region, reported per drawing instance. */
export interface RedactionHit {
  /** 1-based page number. */
  page: number;
  char: string;
  quad: Quad;
}

/** Intersection areas below this threshold count as zero (boundary touch). */
const AREA_EPSILON = 1e-9;

interface HitGlyph {
  glyph: GlyphInstance;
}

function findHitGlyphs(glyphs: GlyphInstance[], regions: RedactionRegion[]): HitGlyph[] {
  const hits: HitGlyph[] = [];
  for (const glyph of glyphs) {
    const page = glyph.pageIndex + 1;
    for (const region of regions) {
      if (region.page !== page) continue;
      if (quadRectIntersectionArea(glyph.quad, region) > AREA_EPSILON) {
        hits.push({ glyph });
        break; // multiple regions hitting the same glyph count once
      }
    }
  }
  return hits;
}

/** Return every glyph whose hit quad overlaps any region with positive area. */
export function preview(pdfBytes: Uint8Array, regions: RedactionRegion[]): RedactionHit[] {
  const doc = parsePdf(pdfBytes);
  const glyphs = extractGlyphs(doc);
  return findHitGlyphs(glyphs, regions).map(({ glyph }) => ({
    page: glyph.pageIndex + 1,
    char: glyph.char,
    quad: glyph.quad,
  }));
}

/** Rewrite plan for one content stream: which glyphs to delete and which Do
 *  invocations need their target form replaced by a redacted clone. */
interface RewriteNode {
  /** Tj/TJ operator token index -> set of glyph ordinals to remove. */
  deletions: Map<number, Set<number>>;
  /** Do operator token index -> the form it draws and the plan for its stream. */
  children: Map<number, { formObjId: number; node: RewriteNode }>;
}

function newNode(): RewriteNode {
  return { deletions: new Map(), children: new Map() };
}

/** Deep-copies a resource structure, inlining referenced dicts/arrays so the
 *  copy can be mutated without affecting shared source objects. Stream
 *  references (fonts are dicts here, XObjects are streams) are kept as refs. */
function deepCopyResources(doc: PdfDocument, obj: PdfObject): PdfObject {
  switch (obj.kind) {
    case 'ref': {
      const target = deref(doc, obj);
      if (target.kind === 'dict' || target.kind === 'array') {
        return deepCopyResources(doc, target);
      }
      return obj;
    }
    case 'dict': {
      const entries = new Map<string, PdfObject>();
      for (const [k, v] of obj.entries) entries.set(k, deepCopyResources(doc, v));
      return dict(entries);
    }
    case 'array':
      return { kind: 'array', items: obj.items.map((item) => deepCopyResources(doc, item)) };
    default:
      return obj;
  }
}

class Rewriter {
  private nextObjId: number;
  private freshCounter = 0;

  constructor(private doc: PdfDocument) {
    this.nextObjId = Math.max(...doc.objects.keys()) + 1;
  }

  private register(obj: PdfObject): number {
    const id = this.nextObjId++;
    this.doc.objects.set(id, obj);
    return id;
  }

  private freshXObjectName(xobjects: PdfDict): string {
    for (;;) {
      const name = `Rd${this.freshCounter++}`;
      if (!xobjects.entries.has(name)) return name;
    }
  }

  private addXObject(resources: PdfDict, formObjId: number): string {
    let xobj = resources.entries.get('XObject');
    if (xobj === undefined) {
      const created = dict([]);
      resources.entries.set('XObject', created);
      xobj = created;
    }
    const xdict = xobj.kind === 'ref' ? deref(this.doc, xobj) : xobj;
    if (xdict.kind !== 'dict') throw new Error('/XObject is not a dict');
    const name = this.freshXObjectName(xdict);
    xdict.entries.set(name, ref(formObjId));
    return name;
  }

  /** Clone the content stream of `streamObjId`, applying the rewrite plan, and
   *  register the clone as a new indirect object. `inheritedResources` is the
   *  resource dict (in the rewritten document) that Do-name lookups inside
   *  this stream fall back to when the stream's own object has no /Resources. */
  rewriteStream(streamObjId: number, node: RewriteNode, inheritedResources: PdfDict, isForm: boolean): number {
    const stream = getStream(this.doc, streamObjId);
    const newDict = dict(new Map(stream.dict.entries));
    newDict.entries.delete('Filter'); // rewritten streams are stored uncompressed

    let effectiveResources = inheritedResources;
    if (isForm) {
      const own = newDict.entries.get('Resources');
      if (own !== undefined) {
        const copied = deepCopyResources(this.doc, own);
        newDict.entries.set('Resources', copied);
        const copiedDict = copied.kind === 'dict' ? copied : deref(this.doc, copied);
        if (copiedDict.kind !== 'dict') throw new Error('form /Resources is not a dict');
        effectiveResources = copiedDict;
      }
    }

    const tokens = tokenizeContent(decodeStreamData(stream.dict, stream.data));

    for (const [doTokenIndex, child] of node.children) {
      const childId = this.rewriteStream(child.formObjId, child.node, effectiveResources, true);
      const name = this.addXObject(effectiveResources, childId);
      const opToken = tokens[doTokenIndex];
      const nameOperand = tokens[doTokenIndex - 1];
      if (!opToken || opToken.type !== 'operator' || opToken.op !== 'Do' || !nameOperand || nameOperand.type !== 'name') {
        throw new Error('rewrite plan out of sync with stream tokens (Do)');
      }
      tokens[doTokenIndex - 1] = nameToken(name);
    }

    for (const [opTokenIndex, ordinals] of node.deletions) {
      applyDeletions(tokens, opTokenIndex, ordinals);
    }

    const newStream: PdfStream = { kind: 'stream', dict: newDict, data: serializeTokens(tokens) };
    return this.register(newStream);
  }
}

/** Rebuild the operand of one Tj/TJ operator with the given glyph ordinals
 *  removed, inserting TJ adjustments so surviving glyphs keep their exact
 *  positions (removed Courier glyphs still contribute their 600-unit advance). */
function applyDeletions(tokens: ContentToken[], opTokenIndex: number, ordinals: Set<number>): void {
  const opToken = tokens[opTokenIndex];
  const operand = tokens[opTokenIndex - 1];
  if (!opToken || opToken.type !== 'operator' || (opToken.op !== 'Tj' && opToken.op !== 'TJ')) {
    throw new Error('rewrite plan out of sync with stream tokens (Tj/TJ)');
  }
  let elements: ContentToken[];
  if (opToken.op === 'Tj') {
    if (!operand || operand.type !== 'string') throw new Error('bad Tj operand');
    elements = [operand];
  } else {
    if (!operand || operand.type !== 'array') throw new Error('bad TJ operand');
    elements = operand.elements;
  }

  const rebuilt: ContentToken[] = [];
  let currentString: number[] = [];
  let pendingAdjust = 0;
  let ordinal = 0;
  const flushString = () => {
    if (currentString.length > 0) {
      rebuilt.push(literalStringToken(new Uint8Array(currentString)));
      currentString = [];
    }
  };
  const flushAdjust = () => {
    if (pendingAdjust !== 0) {
      rebuilt.push(numberToken(pendingAdjust));
      pendingAdjust = 0;
    }
  };
  for (const el of elements) {
    if (el.type === 'string') {
      for (const byte of el.bytes) {
        if (ordinals.has(ordinal++)) {
          flushString();
          pendingAdjust -= 600; // keep the removed glyph's advance
        } else {
          if (currentString.length === 0) flushAdjust();
          currentString.push(byte);
        }
      }
    } else if (el.type === 'number') {
      flushString();
      pendingAdjust += el.value;
    }
  }
  flushString();
  flushAdjust();

  tokens[opTokenIndex - 1] = arrayToken(rebuilt);
  if (opToken.op === 'Tj') {
    tokens[opTokenIndex] = { type: 'operator', raw: 'TJ', op: 'TJ' };
  }
}

/** Return a new PDF with exactly the glyphs that `preview` would report
 *  removed. Shared Form XObjects are un-shared along the hit path so other
 *  drawing instances keep their text. The input bytes are not modified. */
export function burnIn(pdfBytes: Uint8Array, regions: RedactionRegion[]): Uint8Array {
  const doc = parsePdf(pdfBytes);
  const glyphs = extractGlyphs(doc);
  const hits = findHitGlyphs(glyphs, regions);
  if (hits.length === 0) return serializePdf(doc);

  // Build a rewrite tree per page, keyed by the Do-invocation path, so that
  // only the hit drawing instances get cloned and redacted.
  const pagePlans = new Map<number, RewriteNode>();
  for (const { glyph } of hits) {
    let node: RewriteNode = pagePlans.get(glyph.pageIndex) ?? newNode();
    pagePlans.set(glyph.pageIndex, node);
    for (const site of glyph.path) {
      let child = node.children.get(site.doTokenIndex);
      if (!child) {
        child = { formObjId: site.formObjId, node: newNode() };
        node.children.set(site.doTokenIndex, child);
      }
      node = child.node;
    }
    let ordinals = node.deletions.get(glyph.opTokenIndex);
    if (!ordinals) {
      ordinals = new Set();
      node.deletions.set(glyph.opTokenIndex, ordinals);
    }
    ordinals.add(glyph.glyphOrdinal);
  }

  const rewriter = new Rewriter(doc);
  const pages = listPages(doc);
  for (const [pageIndex, plan] of pagePlans) {
    const page = pages[pageIndex];
    if (!page) throw new Error(`no page with index ${pageIndex}`);
    const newContentsId = rewriter.rewriteStream(page.contentsObjId, plan, page.resources, false);
    if (page.objId < 0) throw new Error('page object is not indirect');
    const pageDict = doc.objects.get(page.objId);
    if (!pageDict || pageDict.kind !== 'dict') throw new Error('page object is not a dict');
    pageDict.entries.set('Contents', ref(newContentsId));
  }
  return serializePdf(doc);
}
