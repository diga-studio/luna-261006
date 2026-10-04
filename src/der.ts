/** Minimal DER (not BER) reader. Throws DerError on any malformed input. */

export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DerError';
  }
}

export interface DerNode {
  /** 0=universal 1=application 2=context-specific 3=private */
  tagClass: number;
  constructed: boolean;
  tagNumber: number;
  /** Content octets (without tag/length header). */
  value: Uint8Array;
  /** Complete TLV encoding, header included. */
  raw: Uint8Array;
  /** Parsed children when constructed; null for primitives. */
  children: DerNode[] | null;
}

const MAX_DEPTH = 32;

function parseAt(data: Uint8Array, offset: number, depth: number): { node: DerNode; next: number } {
  if (depth > MAX_DEPTH) throw new DerError('nesting too deep');
  if (offset + 2 > data.length) throw new DerError('truncated header');

  const first = data[offset]!;
  const tagClass = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tagNumber = first & 0x1f;
  let pos = offset + 1;

  if (tagNumber === 0x1f) {
    tagNumber = 0;
    let byte: number;
    do {
      if (pos >= data.length) throw new DerError('truncated long-form tag');
      byte = data[pos++]!;
      if (tagNumber > 0x00ffffff) throw new DerError('tag number too large');
      tagNumber = tagNumber * 128 + (byte & 0x7f);
    } while (byte & 0x80);
  }

  if (pos >= data.length) throw new DerError('truncated length');
  const lengthByte = data[pos++]!;
  let length: number;
  if (lengthByte < 0x80) {
    length = lengthByte;
  } else {
    const count = lengthByte & 0x7f;
    if (count === 0) throw new DerError('indefinite length is not DER');
    if (count > 4) throw new DerError('length too large');
    if (pos + count > data.length) throw new DerError('truncated long-form length');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + data[pos++]!;
    if (length < 128) throw new DerError('non-minimal long-form length');
  }

  if (pos + length > data.length) throw new DerError('content overruns input');
  const value = data.subarray(pos, pos + length);
  const raw = data.subarray(offset, pos + length);

  let children: DerNode[] | null = null;
  if (constructed) {
    children = [];
    let childOffset = 0;
    while (childOffset < value.length) {
      const parsed = parseAt(value, childOffset, depth + 1);
      children.push(parsed.node);
      childOffset = parsed.next;
    }
  }

  return { node: { tagClass, constructed, tagNumber, value, raw, children }, next: pos + length };
}

/** Parse exactly one TLV that must consume the whole input. */
export function parseTlv(data: Uint8Array): DerNode {
  const { node, next } = parseAt(data, 0, 0);
  if (next !== data.length) throw new DerError('trailing data after TLV');
  return node;
}

/** True when the node is a SEQUENCE. */
export function isSequence(node: DerNode): boolean {
  return node.tagClass === 0 && node.constructed && node.tagNumber === 16;
}

/** Decode an OID node's content into dotted-decimal form. */
export function decodeOid(node: DerNode): string {
  if (node.tagClass !== 0 || node.constructed || node.tagNumber !== 6) {
    throw new DerError('not an OID');
  }
  const bytes = node.value;
  if (bytes.length === 0) throw new DerError('empty OID');
  const first = bytes[0]!;
  const parts: string[] = [String(Math.min(Math.floor(first / 40), 2)), String(first - Math.min(Math.floor(first / 40), 2) * 40)];
  let value = 0;
  let pending = false;
  for (let i = 1; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (value > Number.MAX_SAFE_INTEGER / 256) throw new DerError('OID arc too large');
    value = value * 128 + (byte & 0x7f);
    pending = true;
    if ((byte & 0x80) === 0) {
      parts.push(String(value));
      value = 0;
      pending = false;
    }
  }
  if (pending) throw new DerError('truncated OID arc');
  return parts.join('.');
}
