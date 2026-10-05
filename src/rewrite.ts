/** Burn-in rewriting: clone-and-edit content streams so that only the hit
 *  glyph instances are removed; shared form streams stay intact for other
 *  instances. */
import { PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from '@cantoo/pdf-lib';
import {
  ContentOp,
  Operand,
  encodeLiteralString,
  formatNumber,
  parseContentStream,
} from './content';
import { cloneStreamWithContents, PageInfo, resolveForm, streamContents } from './pdfdoc';
import { GlyphInstance } from './walker';

interface InstanceEdits {
  /** showOpIndex -> glyph indices to remove (direct hits in this stream). */
  showRemovals: Map<number, Set<number>>;
  /** Do ordinals whose invocation subtree contains hits. */
  doInstances: Set<number>;
}

function pathKey(doPath: number[]): string {
  return doPath.join(',');
}

type StringItem = { kind: 'string'; bytes: number[] };
type NumberItem = { kind: 'number'; value: number };

/** Rebuild a Tj/TJ operator without the removed glyphs, inserting TJ
 *  displacement numbers so following text keeps its exact position.
 *  Returns the replacement source, or null to drop the operator. */
export function rebuildShowOp(op: ContentOp, removals: Set<number>): string | null {
  const first = op.operands[0];
  let items: Array<StringItem | NumberItem>;
  if (op.name === 'Tj') {
    if (first?.kind !== 'string') throw new Error('Tj without string');
    items = [first];
  } else {
    if (first?.kind !== 'array') throw new Error('TJ without array');
    items = first.items;
  }

  const out: string[] = [];
  let outHasString = false;
  let pending = 0; // pending TJ displacement number (negative moves forward)
  let glyphIndex = 0;

  const flushPending = () => {
    if (pending !== 0) {
      out.push(formatNumber(pending));
      pending = 0;
    }
  };

  for (const item of items) {
    if (item.kind === 'number') {
      pending += item.value;
      flushPending();
    } else {
      let run: number[] = [];
      for (const byte of item.bytes) {
        if (removals.has(glyphIndex)) {
          if (run.length > 0) {
            out.push(encodeLiteralString(run));
            outHasString = true;
            run = [];
          }
          pending -= 600; // replicate the removed glyph's advance
        } else {
          flushPending();
          run.push(byte);
        }
        glyphIndex++;
      }
      if (run.length > 0) {
        out.push(encodeLiteralString(run));
        outHasString = true;
      }
    }
  }
  flushPending();

  if (out.length === 0) return null;
  if (op.name === 'Tj' && out.length === 1 && outHasString) {
    return `${out[0]} Tj`;
  }
  return `[ ${out.join(' ')} ] TJ`;
}

class Rewriter {
  private edits = new Map<string, InstanceEdits>();
  private nameCounter = 0;

  constructor(
    private doc: PDFDocument,
    hits: GlyphInstance[],
  ) {
    for (const hit of hits) {
      const direct = this.editsFor(hit.doPath);
      let set = direct.showRemovals.get(hit.showOpIndex);
      if (!set) {
        set = new Set();
        direct.showRemovals.set(hit.showOpIndex, set);
      }
      set.add(hit.glyphIndex);
      // mark every ancestor Do invocation on the path to this hit
      for (let depth = 0; depth < hit.doPath.length; depth++) {
        this.editsFor(hit.doPath.slice(0, depth)).doInstances.add(hit.doPath[depth]!);
      }
    }
  }

  private editsFor(doPath: number[]): InstanceEdits {
    const key = pathKey(doPath);
    let edit = this.edits.get(key);
    if (!edit) {
      edit = { showRemovals: new Map(), doInstances: new Set() };
      this.edits.set(key, edit);
    }
    return edit;
  }

  private freshName(resources: PDFDict | null, additions: Map<string, PDFRef>): string {
    const xobject = resources?.lookup(PDFName.of('XObject'));
    const existing = new Set<string>();
    if (xobject instanceof PDFDict) {
      for (const [key] of xobject.entries()) existing.add(key.asString());
    }
    for (;;) {
      const name = `/Cd${this.nameCounter++}`;
      if (!existing.has(name) && !additions.has(name.slice(1))) return name;
    }
  }

  private buildResources(
    effective: PDFDict | null,
    additions: Map<string, PDFRef>,
  ): PDFDict {
    const ctx = this.doc.context;
    const newResources = ctx.obj({}) as PDFDict;
    if (effective) {
      for (const [key, value] of effective.entries()) {
        if (key.asString() !== '/XObject') newResources.set(key, value);
      }
    }
    const newXObject = ctx.obj({}) as PDFDict;
    const oldXObject = effective?.lookup(PDFName.of('XObject'));
    if (oldXObject instanceof PDFDict) {
      for (const [key, value] of oldXObject.entries()) newXObject.set(key, value);
    }
    for (const [name, ref] of additions) {
      newXObject.set(PDFName.of(name), ref);
    }
    newResources.set(PDFName.of('XObject'), newXObject);
    return newResources;
  }

  /** Rewrite one drawn instance of a stream. Returns null when nothing in
   *  this instance changes. When the rewritten stream references cloned
   *  forms under fresh names, `attachResources` is called with the clone
   *  and a new Resources dict (effective resources + the additions). */
  rewriteInstance(
    stream: PDFStream,
    resources: PDFDict | null,
    doPath: number[],
    attachResources: (clone: PDFStream, dict: PDFDict) => void,
  ): { ref: PDFRef } | null {
    const edit = this.edits.get(pathKey(doPath));
    if (!edit) return null;

    const data = streamContents(stream);
    const ops = parseContentStream(data);
    const additions = new Map<string, PDFRef>();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let cursor = 0;
    let showOpIndex = 0;
    let doIndex = 0;

    for (const op of ops) {
      let replacement: string | null | undefined;
      if (op.name === 'Tj' || op.name === 'TJ') {
        const removals = edit.showRemovals.get(showOpIndex);
        if (removals) replacement = rebuildShowOp(op, removals);
        showOpIndex++;
      } else if (op.name === 'Do') {
        if (edit.doInstances.has(doIndex)) {
          const nameOp = op.operands[0];
          if (nameOp?.kind !== 'name') throw new Error('Do without name');
          const form = resolveForm(resources, nameOp.value);
          if (!form) throw new Error(`cannot resolve form /${nameOp.value}`);
          const child = this.rewriteInstance(
            form.stream,
            form.resources ?? resources,
            [...doPath, doIndex],
            (clone, dict) => {
              clone.dict.set(PDFName.of('Resources'), dict);
            },
          );
          if (!child) throw new Error('internal: expected child rewrite');
          const newName = this.freshName(resources, additions);
          additions.set(newName.slice(1), child.ref);
          replacement = `${newName} Do`;
        }
        doIndex++;
      }
      if (replacement === undefined) {
        parts.push(decoder.decode(data.subarray(cursor, op.rawEnd)));
      } else {
        parts.push(decoder.decode(data.subarray(cursor, op.rawStart)));
        if (replacement !== null) parts.push(replacement);
      }
      cursor = op.rawEnd;
    }
    parts.push(decoder.decode(data.subarray(cursor)));

    const newBytes = new TextEncoder().encode(parts.join(''));
    const cloned = cloneStreamWithContents(this.doc, stream, newBytes);
    if (additions.size > 0) {
      attachResources(cloned.stream, this.buildResources(resources, additions));
    }
    return { ref: cloned.ref };
  }
}

export function applyRedactions(
  doc: PDFDocument,
  pages: PageInfo[],
  hits: GlyphInstance[],
): void {
  const hitsByPage = new Map<number, GlyphInstance[]>();
  for (const hit of hits) {
    const list = hitsByPage.get(hit.page) ?? [];
    list.push(hit);
    hitsByPage.set(hit.page, list);
  }
  for (const page of pages) {
    const pageHits = hitsByPage.get(page.index);
    if (!pageHits || pageHits.length === 0) continue;
    const rewriter = new Rewriter(doc, pageHits);
    const result = rewriter.rewriteInstance(
      page.contents,
      page.resources,
      [],
      (_clone, dict) => {
        page.leaf.set(PDFName.of('Resources'), dict);
      },
    );
    if (result) {
      page.leaf.set(PDFName.of('Contents'), result.ref);
    }
  }
}
