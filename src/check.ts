import { StampError, SVG_NS, XLINK_NS, XmlElement } from "./model";

/** Maximum logical expanded node count. */
export const MAX_NODES = 10000;

const COMMON_ATTRS = ["id", "transform", "fill", "stroke", "stroke-width", "opacity"];

const ATTRS_BY_ELEMENT: Record<string, readonly string[]> = {
  svg: [...COMMON_ATTRS, "width", "height", "viewBox"],
  g: COMMON_ATTRS,
  defs: COMMON_ATTRS,
  use: [...COMMON_ATTRS, "x", "y", "href"],
  path: [...COMMON_ATTRS, "d"],
  rect: [...COMMON_ATTRS, "x", "y", "width", "height", "rx", "ry"],
  circle: [...COMMON_ATTRS, "cx", "cy", "r"],
};

const LEAF_ELEMENTS = new Set(["use", "path", "rect", "circle"]);
const REF_TARGET_ELEMENTS = new Set(["g", "use", "path", "rect", "circle"]);

const COLOR_RE = /^(none|#[0-9a-fA-F]{6})$/;
const DIMENSION_RE = /^([0-9]+)(px)?$/;

/** Result of semantic validation of a parsed stamp document. */
export interface CheckedStamp {
  root: XmlElement;
  /** Root width in px (1..4096). */
  width: number;
  /** Root height in px (1..4096). */
  height: number;
  /** Optional viewBox attribute value, preserved verbatim. */
  viewBox: string | null;
  /** Logical expanded node count (root and defs excluded). */
  nodes: number;
  /** Resolved use -> target element edges. */
  useTargets: Map<XmlElement, XmlElement>;
}

function noNsAttr(el: XmlElement, local: string): string | null {
  for (const attr of el.attrs) {
    if (attr.ns === null && attr.local === local) return attr.value;
  }
  return null;
}

function parseRootDimension(el: XmlElement, name: string): number {
  const raw = noNsAttr(el, name);
  if (raw === null) throw new StampError(`root svg is missing ${name}`);
  const match = DIMENSION_RE.exec(raw);
  if (match === null) throw new StampError(`invalid root ${name}: ${raw}`);
  const value = parseInt(match[1]!, 10);
  if (value < 1 || value > 4096) {
    throw new StampError(`root ${name} out of range: ${value}`);
  }
  return value;
}

/**
 * Validate a parsed stamp document: element/attribute profile, id and
 * reference integrity, root dimensions, and the logical node budget.
 */
export function checkStamp(root: XmlElement): CheckedStamp {
  if (root.ns !== SVG_NS || root.local !== "svg") {
    throw new StampError("root element must be an SVG <svg>");
  }

  const byId = new Map<string, XmlElement>();
  const uses: Array<{ el: XmlElement; ref: string }> = [];

  // Iterative walk: [element, isRoot, parentIsRoot]
  const walk: Array<{ el: XmlElement; isRoot: boolean; parentIsRoot: boolean }> = [
    { el: root, isRoot: true, parentIsRoot: false },
  ];
  while (walk.length > 0) {
    const { el, isRoot, parentIsRoot } = walk.pop()!;
    const { local } = el;

    if (el.ns !== SVG_NS) {
      throw new StampError(`element <${local}> is not in the SVG namespace`);
    }
    const allowedAttrs = ATTRS_BY_ELEMENT[local];
    if (allowedAttrs === undefined) {
      throw new StampError(`unsupported element <${local}>`);
    }
    if (local === "svg" && !isRoot) {
      throw new StampError("<svg> is only allowed as the root element");
    }
    if (local === "defs" && !parentIsRoot) {
      throw new StampError("<defs> is only allowed as a direct child of the root");
    }
    if (LEAF_ELEMENTS.has(local) && el.children.length > 0) {
      throw new StampError(`<${local}> must not have element children`);
    }

    let hrefPlain: string | null = null;
    let hrefXlink: string | null = null;
    for (const attr of el.attrs) {
      if (attr.ns === XLINK_NS && attr.local === "href") {
        if (local !== "use") throw new StampError("xlink:href is only allowed on <use>");
        hrefXlink = attr.value;
        continue;
      }
      if (attr.ns !== null) {
        throw new StampError(`unsupported namespaced attribute ${attr.local}`);
      }
      if (!allowedAttrs.includes(attr.local)) {
        throw new StampError(`attribute ${attr.local} is not allowed on <${local}>`);
      }
      if ((attr.local === "fill" || attr.local === "stroke") && !COLOR_RE.test(attr.value)) {
        throw new StampError(`invalid ${attr.local} value: ${attr.value}`);
      }
      if (attr.local === "id") {
        if (byId.has(attr.value)) throw new StampError(`duplicate id ${attr.value}`);
        byId.set(attr.value, el);
      }
      if (local === "use" && attr.local === "href") hrefPlain = attr.value;
    }

    if (local === "use") {
      if (hrefPlain !== null && hrefXlink !== null && hrefPlain !== hrefXlink) {
        throw new StampError("conflicting href and xlink:href on <use>");
      }
      const href = hrefPlain ?? hrefXlink;
      if (href === null) throw new StampError("<use> is missing href");
      if (!href.startsWith("#") || href.length === 1) {
        throw new StampError(`only local fragment references are allowed, got ${href}`);
      }
      uses.push({ el, ref: href.slice(1) });
    }

    for (const child of el.children) {
      walk.push({ el: child, isRoot: false, parentIsRoot: isRoot });
    }
  }

  // Resolve references after the full walk so forward references work.
  const useTargets = new Map<XmlElement, XmlElement>();
  for (const { el, ref } of uses) {
    const target = byId.get(ref);
    if (target === undefined) throw new StampError(`dangling reference #${ref}`);
    if (!REF_TARGET_ELEMENTS.has(target.local)) {
      throw new StampError(`reference #${ref} does not target a g, use or shape`);
    }
    useTargets.set(el, target);
  }

  // Count logical expanded nodes with an early-abort budget. Reachable
  // reference cycles expand without bound and are rejected by the budget.
  let nodes = 0;
  const expand: XmlElement[] = [];
  for (const child of root.children) {
    if (child.local !== "defs") expand.push(child);
  }
  while (expand.length > 0) {
    const el = expand.pop()!;
    nodes++;
    if (nodes > MAX_NODES) {
      throw new StampError(`logical expansion exceeds ${MAX_NODES} nodes`);
    }
    const target = useTargets.get(el);
    if (target !== undefined) {
      expand.push(target);
    } else {
      for (const child of el.children) expand.push(child);
    }
  }

  return {
    root,
    width: parseRootDimension(root, "width"),
    height: parseRootDimension(root, "height"),
    viewBox: noNsAttr(root, "viewBox"),
    nodes,
    useTargets,
  };
}
