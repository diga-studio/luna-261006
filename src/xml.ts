/**
 * Minimal strict XML parser.
 *
 * Deliberately rejects anything outside the safe subset needed for SAML
 * messages: no DOCTYPE, no entity declarations, no external references.
 * Only the five predefined entities and numeric character references are
 * resolved. The parser never performs I/O.
 */

export interface XmlAttribute {
  /** Namespace URI of the attribute, or null when it has no namespace. */
  namespaceURI: string | null;
  /** Prefix as written in the document, or null when unprefixed. */
  prefix: string | null;
  localName: string;
  value: string;
}

export interface XmlText {
  kind: "text";
  text: string;
  parent: XmlElement;
}

export interface XmlElement {
  kind: "element";
  namespaceURI: string;
  prefix: string | null;
  localName: string;
  attributes: XmlAttribute[];
  children: XmlNode[];
  parent: XmlElement | null;
  /** All in-scope namespace bindings (prefix -> URI, "" = default). */
  inScopeNamespaces: ReadonlyMap<string, string>;
}

export type XmlNode = XmlElement | XmlText;

export interface XmlDocument {
  root: XmlElement;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const MAX_DEPTH = 256;

const NAME_START = /[A-Za-z_:À-˿Ͱ-῿Ⰰ-퟿]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-˿Ͱ-῿Ⰰ-퟿]/;

function fail(message: string): never {
  throw new XmlParseError(message);
}

function isValidXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** Concatenated character data of an element (DOM textContent). */
export function textContent(element: XmlElement): string {
  let out = "";
  const walk = (el: XmlElement): void => {
    for (const child of el.children) {
      if (child.kind === "text") out += child.text;
      else walk(child);
    }
  };
  walk(element);
  return out;
}

/** Depth-first iteration over all elements in the document. */
export function* allElements(doc: XmlDocument): Generator<XmlElement> {
  const stack: XmlElement[] = [doc.root];
  while (stack.length > 0) {
    const el = stack.pop()!;
    yield el;
    for (let i = el.children.length - 1; i >= 0; i--) {
      const child = el.children[i]!;
      if (child.kind === "element") stack.push(child);
    }
  }
}

/** Find a direct child element by namespace URI and local name. */
export function directChildren(
  element: XmlElement,
  namespaceURI: string,
  localName: string
): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of element.children) {
    if (
      child.kind === "element" &&
      child.namespaceURI === namespaceURI &&
      child.localName === localName
    ) {
      out.push(child);
    }
  }
  return out;
}

/** Get an attribute by local name with no namespace. */
export function getAttribute(
  element: XmlElement,
  localName: string
): string | undefined {
  for (const attr of element.attributes) {
    if (attr.namespaceURI === null && attr.localName === localName) {
      return attr.value;
    }
  }
  return undefined;
}

interface RawAttribute {
  prefix: string | null;
  localName: string;
  qname: string;
  value: string;
  isXmlns: boolean;
  xmlnsPrefix: string | null; // "" for default decl
}

class Parser {
  private pos = 0;
  private readonly input: string;

  constructor(xml: string) {
    // XML line-ending normalization (literal characters only).
    this.input = xml.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  parse(): XmlDocument {
    this.skipPrologMisc();
    if (this.peek() !== "<") fail("expected root element");
    const root = this.parseElement(null, 0);
    this.skipPrologMisc();
    if (this.pos !== this.input.length) {
      fail("unexpected content after root element");
    }
    return { root };
  }

  private peek(): string {
    return this.input[this.pos] ?? "";
  }

  private startsWith(s: string): boolean {
    return this.input.startsWith(s, this.pos);
  }

  private skipPrologMisc(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.startsWith("<?")) {
        this.skipProcessingInstruction();
      } else if (this.startsWith("<!--")) {
        this.skipComment();
      } else if (this.startsWith("<!")) {
        fail("DOCTYPE and markup declarations are not allowed");
      } else {
        return;
      }
    }
  }

  private skipWhitespace(): void {
    while (
      this.pos < this.input.length &&
      (this.input[this.pos] === " " ||
        this.input[this.pos] === "\t" ||
        this.input[this.pos] === "\n")
    ) {
      this.pos++;
    }
  }

  private skipProcessingInstruction(): void {
    // Assumes current position is "<?".
    const end = this.input.indexOf("?>", this.pos + 2);
    if (end === -1) fail("unterminated processing instruction");
    const target = this.input.slice(this.pos + 2, end).trimStart();
    if (/^xml$/i.test(target.split(/[\s?]/, 1)[0] ?? "") && this.pos !== 0) {
      fail("XML declaration is only allowed at the very beginning");
    }
    this.pos = end + 2;
  }

  private skipComment(): void {
    // Assumes current position is "<!--".
    const end = this.input.indexOf("-->", this.pos + 4);
    if (end === -1) fail("unterminated comment");
    if (this.input.indexOf("--", this.pos + 4) !== end) {
      fail('"--" is not allowed inside comments');
    }
    this.pos = end + 3;
  }

  private parseName(): string {
    const start = this.pos;
    const first = this.input[this.pos] ?? "";
    if (!NAME_START.test(first)) fail("expected a name");
    this.pos++;
    while (this.pos < this.input.length && NAME_CHAR.test(this.input[this.pos]!)) {
      this.pos++;
    }
    return this.input.slice(start, this.pos);
  }

  private splitQName(qname: string): { prefix: string | null; localName: string } {
    const idx = qname.indexOf(":");
    if (idx === -1) return { prefix: null, localName: qname };
    if (qname.indexOf(":", idx + 1) !== -1) fail(`malformed QName "${qname}"`);
    return { prefix: qname.slice(0, idx), localName: qname.slice(idx + 1) };
  }

  private parseReference(): string {
    // Assumes current position is "&".
    const end = this.input.indexOf(";", this.pos);
    if (end === -1) fail("unterminated entity reference");
    const body = this.input.slice(this.pos + 1, end);
    this.pos = end + 1;
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        break;
    }
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      if (Number.isNaN(code) || !isValidXmlChar(code)) {
        fail(`invalid character reference "&${body};"`);
      }
      return String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      if (Number.isNaN(code) || !isValidXmlChar(code)) {
        fail(`invalid character reference "&${body};"`);
      }
      return String.fromCodePoint(code);
    }
    fail(`undefined entity "&${body};" (entity declarations are not allowed)`);
  }

  private parseAttributeValue(): string {
    const quote = this.input[this.pos];
    if (quote !== '"' && quote !== "'") fail("expected quoted attribute value");
    this.pos++;
    let out = "";
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos]!;
      if (ch === quote) {
        this.pos++;
        return out;
      }
      if (ch === "<") fail('"<" is not allowed in attribute values');
      if (ch === "&") {
        out += this.parseReference();
      } else if (ch === "\t" || ch === "\n") {
        // Attribute-value normalization (all attributes are CDATA-type here).
        out += " ";
        this.pos++;
      } else {
        out += ch;
        this.pos++;
      }
    }
    fail("unterminated attribute value");
  }

  private parseElement(parent: XmlElement | null, depth: number): XmlElement {
    if (depth > MAX_DEPTH) fail("document is nested too deeply");
    // Assumes current position is "<" starting a tag.
    this.pos++;
    const qname = this.parseName();
    const rawAttrs: RawAttribute[] = [];
    const seenQnames = new Set<string>();
    let selfClosing = false;

    for (;;) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === "") fail("unterminated start tag");
      if (ch === ">") {
        this.pos++;
        break;
      }
      if (ch === "/" && this.input[this.pos + 1] === ">") {
        this.pos += 2;
        selfClosing = true;
        break;
      }
      const attrName = this.parseName();
      if (seenQnames.has(attrName)) fail(`duplicate attribute "${attrName}"`);
      seenQnames.add(attrName);
      this.skipWhitespace();
      if (this.peek() !== "=") fail(`expected "=" after attribute "${attrName}"`);
      this.pos++;
      this.skipWhitespace();
      const value = this.parseAttributeValue();
      const { prefix, localName } = this.splitQName(attrName);
      if (prefix === null && localName === "xmlns") {
        rawAttrs.push({ prefix, localName, qname: attrName, value, isXmlns: true, xmlnsPrefix: "" });
      } else if (prefix === "xmlns") {
        rawAttrs.push({ prefix, localName, qname: attrName, value, isXmlns: true, xmlnsPrefix: localName });
      } else {
        rawAttrs.push({ prefix, localName, qname: attrName, value, isXmlns: false, xmlnsPrefix: null });
      }
    }

    // Build the in-scope namespace map for this element.
    const inScope = new Map<string, string>(parent ? parent.inScopeNamespaces : []);
    for (const attr of rawAttrs) {
      if (!attr.isXmlns) continue;
      const pfx = attr.xmlnsPrefix!;
      if (pfx === "xml" && attr.value !== XML_NS) {
        fail('the "xml" prefix must not be rebound');
      }
      if (pfx === "xmlns") fail('the "xmlns" prefix must not be declared');
      if (attr.value === XML_NS && pfx !== "xml") {
        fail("the XML namespace must not be bound to another prefix");
      }
      if (attr.value === XMLNS_NS) fail("the xmlns namespace must not be used");
      if (pfx !== "" && attr.value === "") {
        fail("namespace prefixes must not be undeclared");
      }
      if (attr.value === "") inScope.delete("");
      else inScope.set(pfx, attr.value);
    }

    const { prefix, localName } = this.splitQName(qname);
    let namespaceURI: string;
    if (prefix === null) {
      namespaceURI = inScope.get("") ?? "";
    } else if (prefix === "xml") {
      namespaceURI = XML_NS;
    } else {
      const bound = inScope.get(prefix);
      if (bound === undefined) fail(`unbound namespace prefix "${prefix}"`);
      namespaceURI = bound;
    }

    const attributes: XmlAttribute[] = [];
    const seenExpanded = new Set<string>();
    for (const raw of rawAttrs) {
      if (raw.isXmlns) continue;
      let attrNs: string | null = null;
      if (raw.prefix === "xml") {
        attrNs = XML_NS;
      } else if (raw.prefix !== null) {
        const bound = inScope.get(raw.prefix);
        if (bound === undefined) {
          fail(`unbound namespace prefix "${raw.prefix}" on attribute`);
        }
        attrNs = bound;
      }
      const key = `${attrNs ?? ""}${raw.localName}`;
      if (seenExpanded.has(key)) {
        fail(`duplicate attribute "${raw.qname}" (same expanded name)`);
      }
      seenExpanded.add(key);
      attributes.push({
        namespaceURI: attrNs,
        prefix: raw.prefix,
        localName: raw.localName,
        value: raw.value,
      });
    }

    const element: XmlElement = {
      kind: "element",
      namespaceURI,
      prefix,
      localName,
      attributes,
      children: [],
      parent,
      inScopeNamespaces: inScope,
    };

    if (selfClosing) return element;

    // Content.
    for (;;) {
      if (this.pos >= this.input.length) fail(`unterminated element <${qname}>`);
      if (this.startsWith(`</`)) {
        this.pos += 2;
        const closeName = this.parseName();
        this.skipWhitespace();
        if (this.peek() !== ">") fail("malformed end tag");
        this.pos++;
        if (closeName !== qname) {
          fail(`mismatched end tag </${closeName}> for <${qname}>`);
        }
        return element;
      }
      if (this.startsWith("<!--")) {
        this.skipComment();
        continue;
      }
      if (this.startsWith("<?")) {
        this.skipProcessingInstruction();
        continue;
      }
      if (this.startsWith("<![CDATA[")) {
        const end = this.input.indexOf("]]>", this.pos + 9);
        if (end === -1) fail("unterminated CDATA section");
        const text = this.input.slice(this.pos + 9, end);
        this.pos = end + 3;
        if (text.length > 0) {
          element.children.push({ kind: "text", text, parent: element });
        }
        continue;
      }
      if (this.startsWith("<!")) {
        fail("DOCTYPE and markup declarations are not allowed");
      }
      if (this.peek() === "<") {
        element.children.push(this.parseElement(element, depth + 1));
        continue;
      }
      // Character data.
      let text = "";
      while (this.pos < this.input.length && this.peek() !== "<") {
        if (this.peek() === "&") {
          text += this.parseReference();
        } else {
          if (this.startsWith("]]>")) fail('"]]>" is not allowed in content');
          text += this.input[this.pos];
          this.pos++;
        }
      }
      if (text.length > 0) {
        element.children.push({ kind: "text", text, parent: element });
      }
    }
  }
}

/** Parse a UTF-8 XML string into a document tree. Throws XmlParseError. */
export function parseXml(xml: string): XmlDocument {
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  return new Parser(xml).parse();
}
