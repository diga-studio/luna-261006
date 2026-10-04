/** CompactSize (varint) encoding/decoding per the Bitcoin protocol. */

export function encodeCompactSize(value: number | bigint): Uint8Array {
  const n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) {
    throw new RangeError("CompactSize value out of uint64 range");
  }
  if (n < 0xfdn) {
    return Uint8Array.of(Number(n));
  }
  if (n <= 0xffffn) {
    const out = new Uint8Array(3);
    out[0] = 0xfd;
    out[1] = Number(n & 0xffn);
    out[2] = Number((n >> 8n) & 0xffn);
    return out;
  }
  if (n <= 0xffffffffn) {
    const out = new Uint8Array(5);
    out[0] = 0xfe;
    for (let i = 0; i < 4; i++) out[1 + i] = Number((n >> BigInt(8 * i)) & 0xffn);
    return out;
  }
  const out = new Uint8Array(9);
  out[0] = 0xff;
  for (let i = 0; i < 8; i++) out[1 + i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return out;
}

export interface CompactSizeRead {
  value: bigint;
  /** Number of bytes consumed. */
  size: number;
}

export function decodeCompactSize(buf: Uint8Array, offset: number): CompactSizeRead {
  const first = buf[offset];
  if (first === undefined) {
    throw new Error("CompactSize: unexpected end of data");
  }
  if (first < 0xfd) {
    return { value: BigInt(first), size: 1 };
  }
  const widths: Record<number, number> = { 0xfd: 2, 0xfe: 4, 0xff: 8 };
  const width = widths[first]!;
  if (offset + 1 + width > buf.length) {
    throw new Error("CompactSize: unexpected end of data");
  }
  let value = 0n;
  for (let i = 0; i < width; i++) {
    value |= BigInt(buf[offset + 1 + i]!) << BigInt(8 * i);
  }
  return { value, size: 1 + width };
}
