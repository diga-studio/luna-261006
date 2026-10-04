import type { PdfDict, PdfRef, PdfValue } from "./types.js";
import { dictGet, isKind } from "./types.js";
import type { PdfDocument } from "./parser.js";

/** A page with its fully resolved (inherited) geometry and resources. */
export interface PageInfo {
  /** Reference to the page dictionary object. */
  pageRef: PdfRef;
  /** Parsed page dictionary (latest revision). */
  pageDict: PdfDict;
  mediaBox: [number, number, number, number];
  cropBox: [number, number, number, number];
  /** Effective rotation in degrees: 0, 90, 180 or 270. */
  rotate: number;
  /** Effective (inherited) Resources value as written (may be a reference). */
  resources: PdfValue | undefined;
  /** Page Contents value as written (reference, or array of references). */
  contents: PdfValue | undefined;
}

interface Inherited {
  mediaBox?: [number, number, number, number];
  cropBox?: [number, number, number, number];
  rotate?: number;
  resources?: PdfValue;
}

function asBox(value: PdfValue | undefined): [number, number, number, number] | undefined {
  if (!isKind(value, "array") || value.items.length !== 4) return undefined;
  const nums = value.items.map((item) => (typeof item === "number" ? item : NaN));
  if (nums.some((n) => !Number.isFinite(n))) return undefined;
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function asRotate(value: PdfValue | undefined): number | undefined {
  if (typeof value !== "number") return undefined;
  const r = ((value % 360) + 360) % 360;
  return r === 0 || r === 90 || r === 180 || r === 270 ? r : undefined;
}

/** Collects pages in document order, resolving inheritable attributes. */
export function collectPages(doc: PdfDocument): PageInfo[] {
  const root = doc.resolveKey(doc.trailer, "Root");
  if (!isKind(root, "dict")) throw new Error("catalog not found");
  const pagesValue = doc.resolveKey(root, "Pages");
  const pages: PageInfo[] = [];
  const visited = new Set<string>();

  const walk = (nodeValue: PdfValue | undefined, inherited: Inherited): void => {
    const nodeRef = isKind(nodeValue, "ref") ? nodeValue : undefined;
    const node = doc.resolve(nodeValue);
    if (!isKind(node, "dict")) throw new Error("page tree node is not a dictionary");
    if (nodeRef) {
      const key = `${nodeRef.obj} ${nodeRef.gen}`;
      if (visited.has(key)) throw new Error("page tree cycle");
      visited.add(key);
    }
    const next: Inherited = { ...inherited };
    const mediaBox = asBox(doc.resolveKey(node, "MediaBox"));
    if (mediaBox) next.mediaBox = mediaBox;
    const cropBox = asBox(doc.resolveKey(node, "CropBox"));
    if (cropBox) next.cropBox = cropBox;
    const rotate = asRotate(doc.resolveKey(node, "Rotate"));
    if (rotate !== undefined) next.rotate = rotate;
    const resources = dictGet(node, "Resources");
    if (resources !== undefined) next.resources = resources;

    const type = doc.resolveKey(node, "Type");
    const isPage = isKind(type, "name") && type.value === "Page";
    const kids = doc.resolveKey(node, "Kids");
    if (!isPage && isKind(kids, "array")) {
      for (const kid of kids.items) walk(kid, next);
      return;
    }
    if (!nodeRef) throw new Error("page object must be indirect");
    if (!next.mediaBox) throw new Error("page without MediaBox");
    pages.push({
      pageRef: nodeRef,
      pageDict: node,
      mediaBox: next.mediaBox,
      cropBox: next.cropBox ?? next.mediaBox,
      rotate: next.rotate ?? 0,
      resources: next.resources,
      contents: dictGet(node, "Contents"),
    });
  };

  walk(pagesValue, {});
  return pages;
}
