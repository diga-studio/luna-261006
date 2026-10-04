/**
 * A parsed 64-bit hash split into two unsigned 32-bit halves.
 * `hi` holds bits 63..32 (the most significant hex octet), `lo` bits 31..0.
 */
export interface HashParts {
  hi: number;
  lo: number;
}

/** Parses and validates a 16-character hex hash into two 32-bit halves. */
export function parseHexHash(hash: string): HashParts {
  if (typeof hash !== "string" || !/^[0-9a-fA-F]{16}$/.test(hash)) {
    throw new Error(
      `invalid perceptual hash: expected 16 hex characters, got ${JSON.stringify(hash)}`,
    );
  }
  const hi = parseInt(hash.slice(0, 8), 16);
  const lo = parseInt(hash.slice(8), 16);
  return { hi, lo };
}

/** Population count of an unsigned 32-bit integer. */
export function popcount32(x: number): number {
  let v = x >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

/** Exact Hamming distance between two parsed hashes (0..64), all 64 bits counted. */
export function hashDistance(a: HashParts, b: HashParts): number {
  return popcount32(a.hi ^ b.hi) + popcount32(a.lo ^ b.lo);
}
