import { StampError, XmlAttr, XmlElement } from "./model";

const XML_NS = "http://www.w3.org/XML/1998/namespace";

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_.:-]/;

function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

const PREDEFINED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decode predefined and numeric entities; reject anything else. */
function decodeEntities(raw: string): string {
  const amp = raw.indexOf("&");
  if (amp < 0) return raw;
  let out = "";
  let pos = 0;
  let i = amp;
  while (i >= 0) {
    out += raw.slice(pos, i);
    const semi = raw.indexOf(";", i + 1);
    if (semi < 0) throw new StampError("unterminated entity reference");
    const body = raw.slice(i + 1, semi);
    let decoded: string;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      if (body.length <= 2 || Number.isNaN(code) || !isXmlChar(code)) {
        throw new StampError(`invalid character reference &${body};`);
      }
      decoded = String.fromCodePoint(code);
    } else if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      if (body.length <= 1 || Number.isNaN(code) || !isXmlChar(code)) {
        throw new StampError(`invalid character reference &${body};`);
      }
      decoded = String.fromCodePoint(code);
    } else {
      const known = PREDEFINED[body];
      if (known === undefined) {
        throw new StampError(`undefined entity &${body};`);
      }
      decoded = known;
    }
    out += decoded;
    pos = semi + 1;
    i = raw.indexOf("&", pos);
  }
  out += raw.slice(pos);
  return out;
}

interface RawAttr {
  qname: string;
  value: string;
}

interface OpenFrame {
  qname: string;
  el: XmlElement;
  /** Namespace bindings introduced by this element. */
  nsDecls: Array<[string, string]>;
}

class Parser {
  private pos = 0;

  constructor(private readonly text: string) {}

  private error(message: string): never {
    throw new StampError(`XML error at offset ${this.pos}: ${message}`);
  }

  private startsWith(s: string): boolean {
    return this.text.startsWith(s, this.pos);
  }

  private skipWs(): void {
    while (this.pos < this.text.length) {
      const c = this.text[this.pos]!;
      if (c === " " || c === "\t" || c === "\r" || c === "\n") this.pos++;
      else break;
    }
  }

  private readName(): string {
    const start = this.pos;
    if (this.pos >= this.text.length || !NAME_START.test(this.text[this.pos]!)) {
      this.error("expected a name");
    }
    this.pos++;
    while (this.pos < this.text.length && NAME_CHAR.test(this.text[this.pos]!)) {
      this.pos++;
    }
    return this.text.slice(start, this.pos);
  }

  private readAttrValue(): string {
    const quote = this.text[this.pos];
    if (quote !== '"' && quote !== "'") this.error("expected quoted attribute value");
    this.pos++;
    const end = this.text.indexOf(quote, this.pos);
    if (end < 0) this.error("unterminated attribute value");
    const raw = this.text.slice(this.pos, end);
    if (raw.includes("<")) this.error("'<' not allowed in attribute value");
    this.pos = end + 1;
    return decodeEntities(raw);
  }

  /** Skip a comment; returns false if this is not a comment. */
  private trySkipComment(): boolean {
    if (!this.startsWith("<!--")) return false;
    const end = this.text.indexOf("-->", this.pos + 4);
    if (end < 0) this.error("unterminated comment");
    const body = this.text.slice(this.pos + 4, end);
    if (body.includes("--")) this.error("'--' not allowed inside comment");
    this.pos = end + 3;
    return true;
  }

  /** Skip whitespace and comments between markup. */
  private skipMisc(): void {
    for (;;) {
      this.skipWs();
      if (this.trySkipComment()) continue;
      return;
    }
  }

  parse(): XmlElement {
    // XML declaration is only allowed as the very first thing.
    if (this.startsWith("<?xml")) {
      const end = this.text.indexOf("?>", 5);
      if (end < 0) this.error("unterminated XML declaration");
      this.pos = end + 2;
    }
    const stack: OpenFrame[] = [];
    let root: XmlElement | null = null;

    for (;;) {
      this.skipMisc();
      if (this.pos >= this.text.length) break;

      if (this.startsWith("<?")) {
        this.error("processing instructions are not allowed");
      }
      if (this.startsWith("<!")) {
        this.error("DTD and CDATA are not allowed");
      }
      if (this.startsWith("</")) {
        this.pos += 2;
        const qname = this.readName();
        this.skipWs();
        if (this.text[this.pos] !== ">") this.error("expected '>' in end tag");
        this.pos++;
        const frame = stack.pop();
        if (!frame || frame.qname !== qname) {
          this.error(`mismatched end tag </${qname}>`);
        }
        continue;
      }
      if (this.text[this.pos] === "<") {
        this.pos++;
        const qname = this.readName();
        const rawAttrs: RawAttr[] = [];
        const seen = new Set<string>();
        for (;;) {
          this.skipWs();
          if (this.startsWith("/>") || this.text[this.pos] === ">") break;
          const name = this.readName();
          if (seen.has(name)) this.error(`duplicate attribute ${name}`);
          seen.add(name);
          this.skipWs();
          if (this.text[this.pos] !== "=") this.error("expected '=' after attribute name");
          this.pos++;
          this.skipWs();
          rawAttrs.push({ qname: name, value: this.readAttrValue() });
        }
        let selfClosing = false;
        if (this.startsWith("/>")) {
          selfClosing = true;
          this.pos += 2;
        } else {
          this.pos++; // '>'
        }
        const { el, nsDecls } = this.buildElement(qname, rawAttrs, stack);
        const parent = stack[stack.length - 1];
        if (parent) {
          parent.el.children.push(el);
        } else {
          if (root !== null) this.error("multiple root elements");
          root = el;
        }
        if (!selfClosing) {
          stack.push({ qname, el, nsDecls });
        }
        continue;
      }
      // Character data.
      const lt = this.text.indexOf("<", this.pos);
      const raw = this.text.slice(this.pos, lt < 0 ? this.text.length : lt);
      this.pos = lt < 0 ? this.text.length : lt;
      if (raw.includes("]]>")) this.error("']]>' not allowed in character data");
      const decoded = decodeEntities(raw);
      if (stack.length === 0) {
        if (decoded.trim() !== "") this.error("character data outside root element");
      } else if (decoded.trim() !== "") {
        this.error("text content is not allowed in stamp elements");
      }
    }

    if (stack.length > 0) this.error(`unclosed element <${stack[stack.length - 1]!.qname}>`);
    if (root === null) throw new StampError("no root element");
    return root;
  }

  private lookupNs(stack: OpenFrame[], extra: Array<[string, string]>, prefix: string): string | null {
    for (const decls of [extra, ...[...stack].reverse().map((f) => f.nsDecls)]) {
      for (let i = decls.length - 1; i >= 0; i--) {
        if (decls[i]![0] === prefix) return decls[i]![1];
      }
    }
    if (prefix === "xml") return XML_NS;
    return null;
  }

  private splitQname(qname: string): [string | null, string] {
    const first = qname.indexOf(":");
    if (first < 0) return [null, qname];
    if (qname.indexOf(":", first + 1) >= 0) {
      throw new StampError(`invalid qualified name ${qname}`);
    }
    return [qname.slice(0, first), qname.slice(first + 1)];
  }

  private buildElement(
    qname: string,
    rawAttrs: RawAttr[],
    stack: OpenFrame[],
  ): { el: XmlElement; nsDecls: Array<[string, string]> } {
    // Collect namespace declarations first; they apply to this element.
    const nsDecls: Array<[string, string]> = [];
    const rest: RawAttr[] = [];
    for (const attr of rawAttrs) {
      if (attr.qname === "xmlns") {
        nsDecls.push(["", attr.value]);
      } else if (attr.qname.startsWith("xmlns:")) {
        const prefix = attr.qname.slice(6);
        if (prefix === "xmlns") throw new StampError("cannot bind the xmlns prefix");
        if (prefix === "xml" && attr.value !== XML_NS) {
          throw new StampError("cannot rebind the xml prefix");
        }
        if (attr.value === "") throw new StampError("cannot undeclare a prefixed namespace");
        nsDecls.push([prefix, attr.value]);
      } else {
        rest.push(attr);
      }
    }

    const [elPrefix, elLocal] = this.splitQname(qname);
    let elNs: string | null;
    if (elPrefix !== null) {
      elNs = this.lookupNs(stack, nsDecls, elPrefix);
      if (elNs === null) throw new StampError(`undeclared namespace prefix ${elPrefix}`);
    } else {
      elNs = this.lookupNs(stack, nsDecls, "");
    }

    const attrs: XmlAttr[] = [];
    const seenResolved = new Set<string>();
    for (const attr of rest) {
      const [prefix, local] = this.splitQname(attr.qname);
      let ns: string | null = null;
      if (prefix !== null) {
        ns = this.lookupNs(stack, nsDecls, prefix);
        if (ns === null) throw new StampError(`undeclared namespace prefix ${prefix}`);
      }
      const key = `${ns ?? ""}${local}`;
      if (seenResolved.has(key)) {
        throw new StampError(`duplicate attribute ${attr.qname} after namespace resolution`);
      }
      seenResolved.add(key);
      attrs.push({ ns, local, value: attr.value });
    }

    return { el: { ns: elNs, local: elLocal, attrs, children: [] }, nsDecls };
  }
}

/**
 * Parse UTF-8 XML bytes into an element tree.
 * Enforces the input profile: optional BOM, optional XML declaration,
 * comments, predefined and numeric entities only; rejects DTD, custom
 * entities, CDATA and processing instructions.
 */
export function parseXml(bytes: Uint8Array): XmlElement {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StampError("input is not valid UTF-8");
  }
  return new Parser(text).parse();
}
