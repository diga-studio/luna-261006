/** Tiny DER writer used to build certificate fixtures locally. */

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag]), encodeLength(content.length), content);
}

export function seq(...items: Uint8Array[]): Uint8Array {
  return tlv(0x30, concat(...items));
}

export function setOf(...items: Uint8Array[]): Uint8Array {
  return tlv(0x31, concat(...items));
}

export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split('.').map((arc) => {
    if (!/^\d+$/.test(arc)) throw new Error(`bad OID arc: ${arc}`);
    return Number(arc);
  });
  if (arcs.length < 2) throw new Error(`bad OID: ${dotted}`);
  const body: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const encoded: number[] = [arc & 0x7f];
    let rest = arc >> 7;
    while (rest > 0) {
      encoded.unshift(0x80 | (rest & 0x7f));
      rest >>= 7;
    }
    body.push(...encoded);
  }
  return tlv(0x06, new Uint8Array(body));
}

export function nullParams(): Uint8Array {
  return new Uint8Array([0x05, 0x00]);
}

export function integer(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) throw new Error(`bad INTEGER: ${value}`);
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  } while (rest > 0);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(0x02, new Uint8Array(bytes));
}

export function bitString(payload: Uint8Array): Uint8Array {
  return tlv(0x03, concat(new Uint8Array([0]), payload));
}

export function octetString(payload: Uint8Array): Uint8Array {
  return tlv(0x04, payload);
}

export function utf8String(text: string): Uint8Array {
  return tlv(0x0c, new Uint8Array(Buffer.from(text, 'utf8')));
}

export function utcTime(text: string): Uint8Array {
  return tlv(0x17, new Uint8Array(Buffer.from(text, 'ascii')));
}

/** [n] EXPLICIT wrapper (context-specific, constructed). */
export function explicit(tagNumber: number, inner: Uint8Array): Uint8Array {
  return tlv(0xa0 + tagNumber, inner);
}
