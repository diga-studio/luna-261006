// Minimal strict XML parser for DoodleSpark stamps.
// Supports: optional BOM, optional XML declaration, comments,
// predefined and numeric character entities.
// Rejects: DTD, custom entities, processing instructions, CDATA.

export interface XmlAttribute {
  /** Namespace URI, or null for no-namespace attributes. */
  ns: string | null;
  /** Local name without prefix. */
  local: string;
  /** Entity-decoded, whitespace-normalized value. */
  value: string;
}

export interface XmlElement {
  /** Namespace URI resolved from in-scope xmlns declarations. */
  ns: string;
  /** Local name without prefix. */
  local: string;
  attrs: XmlAttribute[];
  children: XmlElement[];
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9._-]/;

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

interface RawAttribute {
  prefix: string | null;
  local: string;
  value: string;
}

interface OpenElement {
  qname: string;
  element: XmlElement;
  /** Namespace bindings introduced by this element, for scope pop. */
  scope: Map<string, string | null>;
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

function fail(message: string): never {
  throw new XmlError(message);
}

function decodeEntities(raw: string, inAttribute: boolean): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "&") {
      const semi = raw.indexOf(";", i + 1);
      if (semi === -1) fail("unterminated entity reference");
      const body = raw.slice(i + 1, semi);
      let decoded: string;
      if (body === "amp") decoded = "&";
      else if (body === "lt") decoded = "<";
      else if (body === "gt") decoded = ">";
      else if (body === "quot") decoded = '"';
      else if (body === "apos") decoded = "'";
      else if (body.startsWith("#x") || body.startsWith("#X")) {
        const hex = body.slice(2);
        if (!/^[0-9a-fA-F]+$/.test(hex)) fail("bad numeric character reference");
        decoded = decodeCodePoint(parseInt(hex, 16));
      } else if (body.startsWith("#")) {
        const dec = body.slice(1);
        if (!/^[0-9]+$/.test(dec)) fail("bad numeric character reference");
        decoded = decodeCodePoint(parseInt(dec, 10));
      } else {
        fail("unsupported entity reference: &" + body + ";");
      }
      out += decoded;
      i = semi + 1;
      continue;
    }
    const code = raw.codePointAt(i)!;
    if (!isValidXmlChar(code)) fail("invalid XML character");
    if (inAttribute && (ch === "\t" || ch === "\n")) {
      out += " ";
    } else {
      out += ch;
    }
    i += ch.length;
  }
  return out;
}

function decodeCodePoint(code: number): string {
  if (!isValidXmlChar(code) || code === 0xd) {
    fail("numeric reference to invalid XML character");
  }
  return String.fromCodePoint(code);
}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private error(message: string): never {
    fail(message + " at offset " + this.pos);
  }

  private startsWith(s: string): boolean {
    return this.text.startsWith(s, this.pos);
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === " " || ch === "\t" || ch === "\n") this.pos++;
      else break;
    }
  }

  private parseName(): string {
    if (this.pos >= this.text.length || !NAME_START.test(this.text[this.pos])) {
      this.error("expected name");
    }
    const start = this.pos;
    this.pos++;
    while (this.pos < this.text.length && NAME_CHAR.test(this.text[this.pos])) {
      this.pos++;
    }
    return this.text.slice(start, this.pos);
  }

  private parseQName(): { prefix: string | null; local: string; qname: string } {
    const first = this.parseName();
    if (this.text[this.pos] === ":") {
      this.pos++;
      const local = this.parseName();
      return { prefix: first, local, qname: first + ":" + local };
    }
    return { prefix: null, local: first, qname: first };
  }

  private parseAttributeValue(): string {
    const quote = this.text[this.pos];
    if (quote !== '"' && quote !== "'") this.error("expected quoted attribute value");
    this.pos++;
    const start = this.pos;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === quote) break;
      if (ch === "<") this.error("'<' not allowed in attribute value");
      this.pos++;
    }
    if (this.pos >= this.text.length) this.error("unterminated attribute value");
    const raw = this.text.slice(start, this.pos);
    this.pos++;
    return decodeEntities(raw, true);
  }

  parseDocument(): XmlElement {
    this.parseXmlDeclaration();
    const nsStack: Map<string, string | null>[] = [new Map([["xml", XML_NS]])];
    const elemStack: OpenElement[] = [];
    let root: XmlElement | null = null;
    let sawRoot = false;

    for (;;) {
      if (this.pos >= this.text.length) break;
      if (this.text[this.pos] === "<") {
        if (this.startsWith("<!--")) {
          this.parseComment();
        } else if (this.startsWith("<!")) {
          this.error("DTD and CDATA are not allowed");
        } else if (this.startsWith("<?")) {
          this.error("processing instructions are not allowed");
        } else if (this.startsWith("</")) {
          if (elemStack.length === 0) this.error("unexpected end tag");
          this.pos += 2;
          const { qname } = this.parseQName();
          this.skipWhitespace();
          if (this.text[this.pos] !== ">") this.error("expected '>'");
          this.pos++;
          const open = elemStack.pop()!;
          if (open.qname !== qname) this.error("mismatched end tag: " + qname);
          nsStack.pop();
          if (elemStack.length === 0) {
            root = open.element;
          } else {
            elemStack[elemStack.length - 1].element.children.push(open.element);
          }
        } else {
          if (sawRoot && elemStack.length === 0) this.error("content after root element");
          this.pos++;
          const { prefix, local, qname } = this.parseQName();
          const rawAttrs = this.parseAttributes();
          let selfClosing = false;
          if (this.startsWith("/>")) {
            selfClosing = true;
            this.pos += 2;
          } else if (this.text[this.pos] === ">") {
            this.pos++;
          } else {
            this.error("expected '>' or '/>'");
          }
          const scope = this.buildScope(rawAttrs, nsStack[nsStack.length - 1]);
          nsStack.push(scope);
          const element = this.buildElement(prefix, local, qname, rawAttrs, scope);
          if (selfClosing) {
            nsStack.pop();
            if (elemStack.length === 0) {
              if (sawRoot) this.error("content after root element");
              root = element;
            } else {
              elemStack[elemStack.length - 1].element.children.push(element);
            }
          } else {
            elemStack.push({ qname, element, scope });
          }
          sawRoot = true;
        }
      } else {
        this.parseText();
      }
    }
    if (elemStack.length > 0) this.error("unclosed element: " + elemStack[elemStack.length - 1].qname);
    if (root === null) this.error("no root element");
    return root;
  }

  private parseXmlDeclaration(): void {
    if (!this.startsWith("<?xml")) return;
    const next = this.text[this.pos + 5];
    if (next !== undefined && next !== " " && next !== "\t" && next !== "\n" && next !== "?") {
      this.error("processing instructions are not allowed");
    }
    const end = this.text.indexOf("?>", this.pos);
    if (end === -1) this.error("unterminated XML declaration");
    const body = this.text.slice(this.pos + 5, end);
    const match = /^\s+version\s*=\s*(["'])1\.[0-9]+\1(\s+encoding\s*=\s*(["'])[A-Za-z][A-Za-z0-9._-]*\3)?(\s+standalone\s*=\s*(["'])(yes|no)\5)?\s*$/.exec(body);
    if (match === null) this.error("malformed XML declaration");
    if (match[2] !== undefined) {
      const enc = /encoding\s*=\s*["']([A-Za-z][A-Za-z0-9._-]*)["']/.exec(body)![1];
      if (enc.toLowerCase() !== "utf-8" && enc.toLowerCase() !== "utf8") {
        this.error("unsupported encoding: " + enc);
      }
    }
    this.pos = end + 2;
  }

  private parseComment(): void {
    const end = this.text.indexOf("-->", this.pos + 4);
    if (end === -1) this.error("unterminated comment");
    const body = this.text.slice(this.pos + 4, end);
    if (body.includes("--")) this.error("'--' not allowed inside comment");
    if (body.endsWith("-")) this.error("comment cannot end with '-'");
    this.pos = end + 3;
  }

  private parseAttributes(): RawAttribute[] {
    const attrs: RawAttribute[] = [];
    const seen = new Set<string>();
    for (;;) {
      this.skipWhitespace();
      const ch = this.text[this.pos];
      if (ch === ">" || ch === "/" || this.pos >= this.text.length) break;
      const { prefix, local, qname } = this.parseQName();
      if (seen.has(qname)) this.error("duplicate attribute: " + qname);
      seen.add(qname);
      this.skipWhitespace();
      if (this.text[this.pos] !== "=") this.error("expected '='");
      this.pos++;
      this.skipWhitespace();
      const value = this.parseAttributeValue();
      attrs.push({ prefix, local, value });
    }
    return attrs;
  }

  private buildScope(
    rawAttrs: RawAttribute[],
    parent: Map<string, string | null>,
  ): Map<string, string | null> {
    const scope = new Map(parent);
    for (const attr of rawAttrs) {
      if (attr.prefix === "xmlns") {
        if (attr.local === "xmlns") this.error("cannot bind the xmlns prefix");
        if (attr.value === "") this.error("cannot undeclare a prefixed namespace");
        scope.set(attr.local, attr.value);
      } else if (attr.prefix === null && attr.local === "xmlns") {
        scope.set("", attr.value === "" ? null : attr.value);
      }
    }
    return scope;
  }

  private buildElement(
    prefix: string | null,
    local: string,
    qname: string,
    rawAttrs: RawAttribute[],
    scope: Map<string, string | null>,
  ): XmlElement {
    if (prefix === "xmlns" || local === "xmlns" && prefix === null) {
      this.error("bad element name: " + qname);
    }
    let ns: string | null;
    if (prefix !== null) {
      const bound = scope.get(prefix);
      if (bound === undefined || bound === null) {
        this.error("unbound namespace prefix: " + prefix);
      }
      ns = bound;
    } else {
      ns = scope.get("") ?? null;
    }
    if (ns === null) this.error("element not in any namespace: " + qname);

    const attrs: XmlAttribute[] = [];
    const seenNsLocal = new Set<string>();
    for (const raw of rawAttrs) {
      if (raw.prefix === "xmlns" || (raw.prefix === null && raw.local === "xmlns")) continue;
      let attrNs: string | null = null;
      if (raw.prefix !== null) {
        const bound = scope.get(raw.prefix);
        if (bound === undefined || bound === null) {
          this.error("unbound namespace prefix: " + raw.prefix);
        }
        attrNs = bound;
        if (attrNs === XMLNS_NS) this.error("xmlns namespace attribute not allowed");
      }
      const key = (attrNs ?? "") + " " + raw.local;
      if (seenNsLocal.has(key)) this.error("duplicate attribute: " + raw.local);
      seenNsLocal.add(key);
      attrs.push({ ns: attrNs, local: raw.local, value: raw.value });
    }
    return { ns, local, attrs, children: [] };
  }

  private parseText(): void {
    const start = this.pos;
    while (this.pos < this.text.length && this.text[this.pos] !== "<") {
      this.pos++;
    }
    const raw = this.text.slice(start, this.pos);
    if (raw.includes("]]>")) this.error("']]>' not allowed in character data");
    const decoded = decodeEntities(raw, false);
    if (decoded.trim() !== "") this.error("character data is not allowed");
  }
}

/** Parses UTF-8 XML bytes into a root element. Throws XmlError. */
export function parseXml(bytes: Uint8Array): XmlElement {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new XmlError("input is not valid UTF-8");
  }
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return new Parser(text).parseDocument();
}
