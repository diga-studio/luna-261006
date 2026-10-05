// DoodleSpark stamp validation and normalization core.
//
// A stamp is a restricted SVG document. Validation and normalization share a
// single pipeline so both operations accept and reject exactly the same input.

import { parseXml, XmlError } from "./xml.ts";
import type { XmlElement } from "./xml.ts";

export interface StampInfo {
  /** Root width in user units (integer 1..4096). */
  width: number;
  /** Root height in user units (integer 1..4096). */
  height: number;
  /** Logical expanded node count, excluding root and defs. */
  nodeCount: number;
}

export class StampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StampError";
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const MAX_INPUT_BYTES = 512 * 1024;
const MAX_NODES = 10000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const CONTAINERS = new Set(["svg", "g", "defs"]);
const SHAPES = new Set(["path", "rect", "circle"]);
const REF_TARGETS = new Set(["g", "use", "path", "rect", "circle"]);

const COMMON_ATTRS = new Set(["id", "transform", "fill", "stroke", "stroke-width", "opacity"]);
const ELEMENT_ATTRS: Record<string, Set<string>> = {
  svg: new Set(["width", "height", "viewBox"]),
  g: new Set(),
  defs: new Set(),
  use: new Set(["x", "y", "href"]),
  path: new Set(["d"]),
  rect: new Set(["x", "y", "width", "height", "rx", "ry"]),
  circle: new Set(["cx", "cy", "r"]),
};

const COLOR_RE = /^(none|#[0-9a-fA-F]{6})$/;
const DIMENSION_RE = /^([0-9]+)(px)?$/;
const ZERO_RE = /^[-+]?0+(\.0+)?(px)?$/;

function fail(message: string): never {
  throw new StampError(message);
}

function getAttr(el: XmlElement, local: string): string | undefined {
  for (const attr of el.attrs) {
    if (attr.ns === null && attr.local === local) return attr.value;
  }
  return undefined;
}

interface UseRef {
  el: XmlElement;
  targetId: string;
}

interface Model {
  root: XmlElement;
  width: number;
  height: number;
  idMap: Map<string, XmlElement>;
  uses: UseRef[];
  visibleChildren: XmlElement[];
}

function checkAttributes(el: XmlElement, isRoot: boolean): void {
  const allowed = ELEMENT_ATTRS[el.local];
  for (const attr of el.attrs) {
    if (attr.ns !== null) {
      if (!(el.local === "use" && attr.ns === XLINK_NS && attr.local === "href")) {
        fail("attribute not allowed: " + attr.local);
      }
      continue;
    }
    if (!COMMON_ATTRS.has(attr.local) && !allowed.has(attr.local)) {
      fail("attribute not allowed on <" + el.local + ">: " + attr.local);
    }
    if ((attr.local === "fill" || attr.local === "stroke") && !COLOR_RE.test(attr.value)) {
      fail("bad " + attr.local + " value: " + attr.value);
    }
  }
  if (isRoot) {
    for (const dim of ["width", "height"] as const) {
      const raw = getAttr(el, dim);
      if (raw === undefined) fail("root missing " + dim);
      const match = DIMENSION_RE.exec(raw);
      if (match === null) fail("bad root " + dim + ": " + raw);
      const value = parseInt(match[1], 10);
      if (value < 1 || value > 4096) fail("root " + dim + " out of range: " + raw);
    }
  }
}

function buildModel(root: XmlElement): Model {
  if (root.ns !== SVG_NS || root.local !== "svg") {
    fail("root element must be <svg> in the SVG namespace");
  }
  const idMap = new Map<string, XmlElement>();
  const uses: UseRef[] = [];
  const visibleChildren: XmlElement[] = [];

  // Iterative walk: [element, parentLocal, depth]
  const stack: Array<{ el: XmlElement; parent: string | null }> = [{ el: root, parent: null }];
  while (stack.length > 0) {
    const { el, parent } = stack.pop()!;
    if (el.ns !== SVG_NS) fail("element not in SVG namespace: " + el.local);
    if (!CONTAINERS.has(el.local) && !SHAPES.has(el.local) && el.local !== "use") {
      fail("unsupported element: " + el.local);
    }
    if (el.local === "svg" && parent !== null) fail("<svg> is only allowed as root");
    if (el.local === "defs" && parent !== "svg") fail("<defs> is only allowed below root");
    if (!CONTAINERS.has(el.local) && el.children.length > 0) {
      fail("<" + el.local + "> cannot have child elements");
    }
    checkAttributes(el, parent === null);

    const id = getAttr(el, "id");
    if (id !== undefined) {
      if (idMap.has(id)) fail("duplicate id: " + id);
      idMap.set(id, el);
    }

    if (el.local === "use") {
      let href: string | undefined;
      for (const attr of el.attrs) {
        if (attr.local !== "href") continue;
        if (attr.ns !== null && attr.ns !== XLINK_NS) continue;
        if (href === undefined) {
          href = attr.value;
        } else if (href !== attr.value) {
          fail("conflicting href and xlink:href on <use>");
        }
      }
      if (href === undefined) fail("<use> without href");
      if (!href.startsWith("#") || href.length < 2) {
        fail("only local #id references are allowed: " + href);
      }
      uses.push({ el, targetId: href.slice(1) });
    }

    if (parent === "svg" && el.local !== "defs") visibleChildren.push(el);

    for (let i = el.children.length - 1; i >= 0; i--) {
      stack.push({ el: el.children[i], parent: el.local });
    }
  }

  for (const use of uses) {
    const target = idMap.get(use.targetId);
    if (target === undefined) fail("dangling reference: #" + use.targetId);
    if (!REF_TARGETS.has(target.local)) {
      fail("reference target must be g, use or a shape: #" + use.targetId);
    }
  }

  const widthRaw = DIMENSION_RE.exec(getAttr(root, "width")!)!;
  const heightRaw = DIMENSION_RE.exec(getAttr(root, "height")!)!;
  return {
    root,
    width: parseInt(widthRaw[1], 10),
    height: parseInt(heightRaw[1], 10),
    idMap,
    uses,
    visibleChildren,
  };
}

/** Rejects reference cycles reachable from the root's visible content. */
function checkCycles(model: Model): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<XmlElement, number>();
  const successors = (el: XmlElement): XmlElement[] => {
    const out: XmlElement[] = [];
    if (CONTAINERS.has(el.local)) out.push(...el.children);
    if (el.local === "use") out.push(model.idMap.get(getHrefId(el))!);
    return out;
  };
  for (const start of model.visibleChildren) {
    if (color.get(start) !== undefined) continue;
    const stack: Array<{ el: XmlElement; next: number; succ: XmlElement[] }> = [
      { el: start, next: 0, succ: successors(start) },
    ];
    color.set(start, GRAY);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.next >= top.succ.length) {
        color.set(top.el, BLACK);
        stack.pop();
        continue;
      }
      const child = top.succ[top.next++];
      const c = color.get(child) ?? WHITE;
      if (c === GRAY) fail("reference cycle reachable from visible content");
      if (c === WHITE) {
        color.set(child, GRAY);
        stack.push({ el: child, next: 0, succ: successors(child) });
      }
    }
  }
}

function getHrefId(useEl: XmlElement): string {
  for (const attr of useEl.attrs) {
    if (attr.local === "href" && (attr.ns === null || attr.ns === XLINK_NS)) {
      return attr.value.slice(1);
    }
  }
  fail("<use> without href");
}

/** Logical expanded node count with memoization; rejects beyond MAX_NODES. */
function countNodes(model: Model): number {
  const memo = new Map<XmlElement, number>();
  const countOf = (start: XmlElement): number => {
    const known = memo.get(start);
    if (known !== undefined) return known;
    // Iterative post-order over the reference DAG (acyclic at this point).
    const stack: Array<{ el: XmlElement; next: number; children: XmlElement[] }> = [];
    const push = (el: XmlElement): void => {
      const children: XmlElement[] = [];
      if (CONTAINERS.has(el.local)) children.push(...el.children);
      if (el.local === "use") children.push(model.idMap.get(getHrefId(el))!);
      stack.push({ el, next: 0, children });
    };
    push(start);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      let advanced = false;
      while (top.next < top.children.length) {
        const child = top.children[top.next];
        if (memo.has(child)) {
          top.next++;
        } else {
          push(child);
          advanced = true;
          break;
        }
      }
      if (advanced) continue;
      let sum = 1;
      for (const child of top.children) {
        sum += memo.get(child)!;
        if (sum > MAX_NODES) fail("logical expansion exceeds " + MAX_NODES + " nodes");
      }
      memo.set(top.el, sum);
      stack.pop();
    }
    return memo.get(start)!;
  };
  let total = 0;
  for (const child of model.visibleChildren) {
    total += countOf(child);
    if (total > MAX_NODES) fail("logical expansion exceeds " + MAX_NODES + " nodes");
  }
  return total;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) n += 1;
    else if (code < 0x800) n += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

class Emitter {
  private chunks: string[] = [];
  private bytes = 0;

  write(chunk: string): void {
    this.bytes += utf8Length(chunk);
    if (this.bytes > MAX_OUTPUT_BYTES) {
      fail("normalized output exceeds 4 MiB");
    }
    this.chunks.push(chunk);
  }

  result(): string {
    return this.chunks.join("");
  }
}

function openTag(el: XmlElement): string {
  let out = "<" + el.local;
  for (const attr of el.attrs) {
    if (attr.local === "id" && attr.ns === null) continue;
    out += " " + attr.local + '="' + escapeAttr(attr.value) + '"';
  }
  return out;
}

/** Wrapper attributes carrying a <use>'s own transform, offset and style. */
function useWrapperAttrs(useEl: XmlElement): string {
  let transform = getAttr(useEl, "transform");
  const x = getAttr(useEl, "x");
  const y = getAttr(useEl, "y");
  const hasX = x !== undefined && !ZERO_RE.test(x.trim());
  const hasY = y !== undefined && !ZERO_RE.test(y.trim());
  if (hasX || hasY) {
    const translate = "translate(" + (hasX ? x!.trim() : "0") + " " + (hasY ? y!.trim() : "0") + ")";
    transform = transform === undefined ? translate : transform + " " + translate;
  }
  let out = "";
  if (transform !== undefined) out += ' transform="' + escapeAttr(transform) + '"';
  for (const name of ["fill", "stroke", "stroke-width", "opacity"]) {
    const value = getAttr(useEl, name);
    if (value !== undefined) out += " " + name + '="' + escapeAttr(value) + '"';
  }
  return out;
}

function emitNormalized(model: Model): string {
  const emitter = new Emitter();
  const root = model.root;
  let rootTag = '<svg xmlns="' + SVG_NS + '"';
  for (const attr of root.attrs) {
    if (attr.local === "id" && attr.ns === null) continue;
    rootTag += " " + attr.local + '="' + escapeAttr(attr.value) + '"';
  }
  emitter.write(rootTag + ">");

  // Iterative expansion: frames are elements to expand or literal closings.
  const stack: Array<XmlElement | string> = [];
  for (let i = model.visibleChildren.length - 1; i >= 0; i--) {
    stack.push(model.visibleChildren[i]);
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (typeof frame === "string") {
      emitter.write(frame);
      continue;
    }
    const el = frame;
    if (el.local === "use") {
      const wrapper = useWrapperAttrs(el);
      if (wrapper !== "") {
        emitter.write("<g" + wrapper + ">");
        stack.push("</g>");
      }
      stack.push(model.idMap.get(getHrefId(el))!);
      continue;
    }
    if (el.children.length === 0) {
      emitter.write(openTag(el) + "/>");
      continue;
    }
    emitter.write(openTag(el) + ">");
    stack.push("</" + el.local + ">");
    for (let i = el.children.length - 1; i >= 0; i--) {
      stack.push(el.children[i]);
    }
  }
  emitter.write("</svg>");
  return emitter.result();
}

interface Processed {
  info: StampInfo;
  output: string;
}

function processStamp(bytes: Uint8Array): Processed {
  if (bytes.length > MAX_INPUT_BYTES) fail("input exceeds 512 KiB");
  let root: XmlElement;
  try {
    root = parseXml(bytes);
  } catch (err) {
    if (err instanceof XmlError) fail("invalid XML: " + err.message);
    throw err;
  }
  const model = buildModel(root);
  checkCycles(model);
  const nodeCount = countNodes(model);
  const output = emitNormalized(model);
  return { info: { width: model.width, height: model.height, nodeCount }, output };
}

/** Validates a stamp and returns root size plus logical node count. */
export function validateStamp(bytes: Uint8Array): StampInfo {
  return processStamp(bytes).info;
}

/** Validates and normalizes a stamp into a standalone SVG string. */
export function normalizeStamp(bytes: Uint8Array): string {
  return processStamp(bytes).output;
}
