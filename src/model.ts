/** Namespace URI for SVG elements. */
export const SVG_NS = "http://www.w3.org/2000/svg";
/** Namespace URI for xlink attributes. */
export const XLINK_NS = "http://www.w3.org/1999/xlink";

/** A single XML attribute with its resolved namespace (null = no namespace). */
export interface XmlAttr {
  /** Resolved namespace URI, or null for a no-namespace attribute. */
  ns: string | null;
  /** Local name without prefix. */
  local: string;
  /** Entity-decoded value. */
  value: string;
}

/** A parsed XML element. Text content is not retained. */
export interface XmlElement {
  /** Resolved namespace URI, or null for no namespace. */
  ns: string | null;
  /** Local name without prefix. */
  local: string;
  attrs: XmlAttr[];
  children: XmlElement[];
}

/** Error thrown for every stamp rejection (parse or semantic). */
export class StampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StampError";
  }
}
