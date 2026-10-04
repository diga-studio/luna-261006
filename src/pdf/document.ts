import { parseIndirectObject } from "./parser.ts";
import {
  asName,
  asNumber,
  dictGet,
  type PdfDict,
  type PdfRef,
  type PdfValue,
} from "./types.ts";
import { loadXrefTables, type XrefTable } from "./xref.ts";

export interface PageInfo {
  /** Reference to the page's own dictionary object. */
  readonly pageRef: PdfRef;
  readonly page: PdfDict;
  /** Effective (inherited) /Resources value, as found (may be a ref). */
  readonly resources: PdfValue | undefined;
  readonly mediaBox: readonly [number, number, number, number];
  readonly cropBox: readonly [number, number, number, number];
  readonly rotate: 0 | 90 | 180 | 270;
}

const DEFAULT_MEDIA_BOX: readonly [number, number, number, number] = [
  0, 0, 612, 792,
];

export class PdfDocument {
  readonly bytes: Uint8Array;
  readonly xref: XrefTable;

  private constructor(bytes: Uint8Array, xref: XrefTable) {
    this.bytes = bytes;
    this.xref = xref;
  }

  static load(bytes: Uint8Array): PdfDocument {
    const xref = loadXrefTables(bytes);
    return new PdfDocument(bytes, xref);
  }

  /** Resolve an indirect reference to its (latest) object value. */
  resolve(ref: PdfRef): PdfValue {
    const entry = this.xref.entries.get(ref.obj);
    if (!entry || !entry.inUse) {
      throw new Error(`object ${ref.obj} ${ref.gen} not found`);
    }
    const parsed = parseIndirectObject(this.bytes, entry.offset, (obj, gen) => {
      const v = this.resolve({ kind: "ref", obj, gen });
      if (v.kind !== "num") {
        throw new Error(`object ${obj} ${gen} is not a number`);
      }
      return Number(v.raw);
    });
    return parsed.value;
  }

  /** Resolve until a non-reference value is reached. */
  deepResolve(value: PdfValue): PdfValue {
    const seen = new Set<number>();
    while (value.kind === "ref") {
      if (seen.has(value.obj)) throw new Error("reference cycle");
      seen.add(value.obj);
      value = this.resolve(value);
    }
    return value;
  }

  private boxOf(
    value: PdfValue | undefined,
  ): readonly [number, number, number, number] | undefined {
    if (!value) return undefined;
    const resolved = this.deepResolve(value);
    if (resolved.kind !== "arr" || resolved.items.length !== 4) {
      return undefined;
    }
    const nums = resolved.items.map((item) =>
      asNumber(this.deepResolve(item)),
    );
    if (nums.some((n) => n === undefined)) return undefined;
    return [
      nums[0]!,
      nums[1]!,
      nums[2]!,
      nums[3]!,
    ] as const;
  }

  /** Pages in document order with inherited attributes resolved. */
  pages(): PageInfo[] {
    const trailer = this.xref.trailer;
    if (!trailer.root) throw new Error("trailer has no /Root");
    const rootRef: PdfRef = { kind: "ref", ...trailer.root };
    const catalog = this.deepResolve(rootRef);
    if (catalog.kind !== "dict") throw new Error("catalog is not a dict");
    const pagesValue = dictGet(catalog, "Pages");
    if (!pagesValue) throw new Error("catalog has no /Pages");
    const pagesRef = pagesValue.kind === "ref" ? pagesValue : undefined;
    const pagesRoot = this.deepResolve(pagesValue);
    if (pagesRoot.kind !== "dict") throw new Error("/Pages is not a dict");

    const out: PageInfo[] = [];
    const visit = (
      node: PdfDict,
      nodeRef: PdfRef | undefined,
      inherited: {
        resources: PdfValue | undefined;
        mediaBox: readonly [number, number, number, number];
        cropBox: readonly [number, number, number, number] | undefined;
        rotate: number;
      },
      depth: number,
    ): void => {
      if (depth > 64) throw new Error("page tree too deep");
      const resources = dictGet(node, "Resources") ?? inherited.resources;
      const mediaBox =
        this.boxOf(dictGet(node, "MediaBox")) ?? inherited.mediaBox;
      const cropBox =
        this.boxOf(dictGet(node, "CropBox")) ?? inherited.cropBox;
      const rotateValue = dictGet(node, "Rotate");
      const rotate =
        rotateValue !== undefined
          ? (asNumber(this.deepResolve(rotateValue)) ?? inherited.rotate)
          : inherited.rotate;
      const type = asName(dictGet(node, "Type"));
      const kidsValue = dictGet(node, "Kids");
      if (type === "Page" || kidsValue === undefined) {
        if (!nodeRef) throw new Error("page object must be indirect");
        const r = ((rotate % 360) + 360) % 360;
        if (r !== 0 && r !== 90 && r !== 180 && r !== 270) {
          throw new Error(`unsupported /Rotate ${rotate}`);
        }
        out.push({
          pageRef: nodeRef,
          page: node,
          resources,
          mediaBox,
          cropBox: cropBox ?? mediaBox,
          rotate: r,
        });
        return;
      }
      const kids = this.deepResolve(kidsValue);
      if (kids.kind !== "arr") throw new Error("/Kids is not an array");
      for (const kid of kids.items) {
        if (kid.kind !== "ref") throw new Error("page tree kid must be a ref");
        const kidNode = this.deepResolve(kid);
        if (kidNode.kind !== "dict") throw new Error("page kid is not a dict");
        visit(
          kidNode,
          kid,
          { resources, mediaBox, cropBox, rotate },
          depth + 1,
        );
      }
    };
    visit(pagesRoot, pagesRef, {
      resources: undefined,
      mediaBox: DEFAULT_MEDIA_BOX,
      cropBox: undefined,
      rotate: 0,
    }, 0);
    return out;
  }
}
