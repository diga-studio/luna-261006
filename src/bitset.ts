/** Bitset helpers over Uint32Array words. */

export function createBitset(size: number): Uint32Array {
  return new Uint32Array(Math.ceil(size / 32));
}

export function setBit(bits: Uint32Array, index: number): void {
  bits[index >>> 5]! |= 1 << (index & 31);
}

export function getBit(bits: Uint32Array, index: number): boolean {
  return (bits[index >>> 5]! & (1 << (index & 31))) !== 0;
}

export function andInto(dst: Uint32Array, src: Uint32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i]! &= src[i]!;
}

export function orInto(dst: Uint32Array, src: Uint32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i]! |= src[i]!;
}

/** dst = ~src, restricted to the low `size` bits. */
export function notInto(dst: Uint32Array, src: Uint32Array, size: number): void {
  for (let i = 0; i < dst.length; i++) dst[i] = ~src[i]!;
  const rem = size & 31;
  if (rem !== 0 && dst.length > 0) {
    dst[dst.length - 1]! &= (1 << rem) - 1;
  }
}

export function cloneBitset(src: Uint32Array): Uint32Array {
  return src.slice();
}
