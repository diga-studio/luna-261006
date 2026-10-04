/** Minimal DER (Distinguished Encoding Rules) reader. */

export interface DerElement {
  /** Raw tag byte (class + constructed bit + tag number). */
  tag: number;
  /** Content octets (without tag/length). */
  value: Uint8Array;
  /** Full original encoding: tag + length + value. */
  raw: Uint8Array;
  /** Children, populated only for constructed elements. */
  children: DerElement[];
}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

export class DerError extends Error {}

function readElement(bytes: Uint8Array, offset: number): { el: DerElement; next: number } {
  if (offset >= bytes.length) throw new DerError("unexpected end of input");
  const tag = bytes[offset];
  if ((tag & 0x1f) === 0x1f) throw new DerError("multi-byte tags not supported");
  if (offset + 1 >= bytes.length) throw new DerError("missing length");
  const lenByte = bytes[offset + 1];
  let headerLen: number;
  let length: number;
  if (lenByte < 0x80) {
    headerLen = 2;
    length = lenByte;
  } else if (lenByte === 0x80) {
    throw new DerError("indefinite length is not DER");
  } else {
    const numBytes = lenByte & 0x7f;
    if (numBytes > 4) throw new DerError("length too large");
    if (offset + 2 + numBytes > bytes.length) throw new DerError("truncated length");
    length = 0;
    for (let i = 0; i < numBytes; i++) {
      length = length * 256 + bytes[offset + 2 + i];
    }
    if (length < 0x80) throw new DerError("non-minimal long-form length");
    headerLen = 2 + numBytes;
  }
  const start = offset + headerLen;
  const end = start + length;
  if (end > bytes.length) throw new DerError("content exceeds input");
  const value = bytes.subarray(start, end);
  const raw = bytes.subarray(offset, end);
  const constructed = (tag & 0x20) !== 0;
  const children: DerElement[] = [];
  if (constructed) {
    let pos = 0;
    while (pos < value.length) {
      const { el, next } = readElement(value, pos);
      children.push(el);
      pos = next;
    }
  }
  return { el: { tag, value, raw, children }, next: end };
}

/** Parse exactly one DER element from `bytes`; throws DerError on malformed input. */
export function parseDer(bytes: Uint8Array): DerElement {
  const { el, next } = readElement(bytes, 0);
  if (next !== bytes.length) throw new DerError("trailing bytes after element");
  return el;
}

/** Decode an OID element's content octets to dotted string form. */
export function decodeOid(value: Uint8Array): string {
  if (value.length === 0) throw new DerError("empty OID");
  const first = value[0];
  const parts: number[] = [Math.min(Math.floor(first / 40), 2), first >= 80 ? first - 80 : first % 40];
  let acc = 0;
  for (let i = 1; i < value.length; i++) {
    const b = value[i];
    acc = acc * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(acc);
      acc = 0;
    }
  }
  if (acc !== 0) throw new DerError("truncated OID arc");
  return parts.join(".");
}
