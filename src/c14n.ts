/**
 * Exclusive XML Canonicalization 1.0 without comments
 * (http://www.w3.org/2001/10/xml-exc-c14n#), including support for the
 * InclusiveNamespaces PrefixList (with "#default").
 *
 * Operates on the parser's element tree. Since the parser already drops
 * comments and processing instructions, "without comments" is inherent.
 */

import type { XmlDocument, XmlElement } from "./xml";

export interface ExcC14nOptions {
  /** Prefixes from an InclusiveNamespaces PrefixList ("#default" allowed). */
  inclusivePrefixes?: readonly string[];
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#xD;");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");
}

function qnameOf(prefix: string | null, localName: string): string {
  return prefix === null ? localName : `${prefix}:${localName}`;
}

function renderElement(
  element: XmlElement,
  ancestorNamespaces: ReadonlyMap<string, string>,
  inclusivePrefixes: ReadonlySet<string>,
  omit: XmlElement | null,
  out: string[]
): void {
  // Namespaces visibly utilized by this element and its attributes.
  const utilized = new Set<string>();
  if (element.prefix !== null) {
    utilized.add(element.prefix);
  } else if (element.namespaceURI !== "") {
    utilized.add(""); // default namespace in use
  }
  for (const attr of element.attributes) {
    if (attr.prefix !== null && attr.prefix !== "xml") {
      utilized.add(attr.prefix);
    }
  }
  for (const p of inclusivePrefixes) {
    utilized.add(p);
  }

  const rendered = new Map(ancestorNamespaces);
  const toRender: string[] = [];
  for (const prefix of utilized) {
    if (prefix === "xml") continue; // implicitly bound, never rendered
    const uri = element.inScopeNamespaces.get(prefix);
    if (uri === undefined) continue; // not in scope: nothing to render
    if (rendered.get(prefix) === uri) continue; // already rendered identically
    rendered.set(prefix, uri);
    toRender.push(prefix);
  }
  toRender.sort();

  out.push("<", qnameOf(element.prefix, element.localName));
  for (const prefix of toRender) {
    const uri = rendered.get(prefix)!;
    if (prefix === "") {
      out.push(' xmlns="', escapeAttribute(uri), '"');
    } else {
      out.push(` xmlns:${prefix}="`, escapeAttribute(uri), '"');
    }
  }

  const sortedAttrs = [...element.attributes].sort((a, b) => {
    const aNs = a.namespaceURI;
    const bNs = b.namespaceURI;
    if (aNs === null && bNs === null) {
      return a.localName < b.localName ? -1 : a.localName > b.localName ? 1 : 0;
    }
    if (aNs === null) return -1;
    if (bNs === null) return 1;
    if (aNs !== bNs) return aNs < bNs ? -1 : 1;
    return a.localName < b.localName ? -1 : a.localName > b.localName ? 1 : 0;
  });
  for (const attr of sortedAttrs) {
    out.push(
      " ",
      qnameOf(attr.prefix, attr.localName),
      '="',
      escapeAttribute(attr.value),
      '"'
    );
  }
  out.push(">");

  for (const child of element.children) {
    if (child.kind === "text") {
      out.push(escapeText(child.text));
    } else if (child !== omit) {
      renderElement(child, rendered, inclusivePrefixes, omit, out);
    }
  }

  out.push("</", qnameOf(element.prefix, element.localName), ">");
}

function normalizePrefixes(options?: ExcC14nOptions): ReadonlySet<string> {
  const set = new Set<string>();
  for (const raw of options?.inclusivePrefixes ?? []) {
    set.add(raw === "#default" ? "" : raw);
  }
  return set;
}

/** Canonicalize a whole document (used for the Reference digest). */
export function canonicalizeDocument(
  doc: XmlDocument,
  options?: ExcC14nOptions,
  omit?: XmlElement
): string {
  const out: string[] = [];
  renderElement(
    doc.root,
    new Map(),
    normalizePrefixes(options),
    omit ?? null,
    out
  );
  return out.join("");
}

/** Canonicalize an element subtree (used for SignedInfo). */
export function canonicalizeElement(
  element: XmlElement,
  options?: ExcC14nOptions
): string {
  const out: string[] = [];
  renderElement(element, new Map(), normalizePrefixes(options), null, out);
  return out.join("");
}
