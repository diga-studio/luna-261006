import { CheckedStamp } from "./check";
import { StampError, SVG_NS, XmlElement } from "./model";

/** Maximum normalized output size in UTF-8 bytes (4 MiB). */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Attributes copied from a use element onto its expansion wrapper. */
const USE_INHERITED_ATTRS = ["fill", "stroke", "stroke-width", "opacity"] as const;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function noNsAttr(el: XmlElement, local: string): string | null {
  for (const attr of el.attrs) {
    if (attr.ns === null && attr.local === local) return attr.value;
  }
  return null;
}

/** Serialize the kept attributes of a cloned element (id and references dropped). */
function serializeAttrs(el: XmlElement): string {
  let out = "";
  for (const attr of el.attrs) {
    if (attr.ns !== null) continue;
    if (attr.local === "id" || attr.local === "href") continue;
    out += ` ${attr.local}="${escapeAttr(attr.value)}"`;
  }
  return out;
}

class Emitter {
  private chunks: string[] = [];
  private bytes = 0;

  constructor(private readonly useTargets: Map<XmlElement, XmlElement>) {}

  private push(chunk: string): void {
    this.bytes += Buffer.byteLength(chunk, "utf8");
    if (this.bytes > MAX_OUTPUT_BYTES) {
      throw new StampError("normalized output exceeds 4MiB");
    }
    this.chunks.push(chunk);
  }

  private useWrapperAttrs(u: XmlElement): string {
    let out = "";
    const transform = noNsAttr(u, "transform");
    const x = noNsAttr(u, "x");
    const y = noNsAttr(u, "y");
    let translate: string | null = null;
    if (x !== null && y !== null) translate = `translate(${x} ${y})`;
    else if (x !== null) translate = `translate(${x})`;
    else if (y !== null) translate = `translate(0 ${y})`;
    const combined = [transform, translate].filter((p) => p !== null).join(" ");
    if (combined !== "") out += ` transform="${escapeAttr(combined)}"`;
    for (const name of USE_INHERITED_ATTRS) {
      const value = noNsAttr(u, name);
      if (value !== null) out += ` ${name}="${escapeAttr(value)}"`;
    }
    return out;
  }

  emit(root: XmlElement): string {
    // Root keeps every whitelisted attribute except id, plus the SVG namespace.
    this.push(`<svg xmlns="${SVG_NS}"${serializeAttrs(root)}>`);
    // Stack of pending actions: elements to expand, or literal closing text.
    const stack: Array<XmlElement | string> = [`</svg>`];
    for (let i = root.children.length - 1; i >= 0; i--) {
      const child = root.children[i]!;
      if (child.local !== "defs") stack.push(child);
    }
    while (stack.length > 0) {
      const item = stack.pop()!;
      if (typeof item === "string") {
        this.push(item);
        continue;
      }
      if (item.local === "use") {
        const target = this.useTargets.get(item)!;
        const wrapper = this.useWrapperAttrs(item);
        if (wrapper === "") {
          stack.push(target);
        } else {
          this.push(`<g${wrapper}>`);
          stack.push("</g>");
          stack.push(target);
        }
        continue;
      }
      const attrs = serializeAttrs(item);
      if (item.children.length === 0) {
        this.push(`<${item.local}${attrs}/>`);
        continue;
      }
      this.push(`<${item.local}${attrs}>`);
      stack.push(`</${item.local}>`);
      for (let i = item.children.length - 1; i >= 0; i--) {
        stack.push(item.children[i]!);
      }
    }
    return this.chunks.join("");
  }
}

/**
 * Render a validated stamp as a standalone SVG string with all use
 * references resolved. Enforces the output byte budget incrementally.
 */
export function emitStamp(checked: CheckedStamp): string {
  return new Emitter(checked.useTargets).emit(checked.root);
}
