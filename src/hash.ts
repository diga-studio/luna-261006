/**
 * 64-bit perceptual hash represented as four 16-bit words.
 * words[0] holds bits 0..15 (least significant), words[3] holds bits 48..63.
 */
export type HashWords = readonly [number, number, number, number];

const HEX_PATTERN = /^[0-9a-fA-F]{16}$/;

const POPCOUNT16 = new Uint8Array(0x10000);
for (let i = 1; i < POPCOUNT16.length; i++) {
  POPCOUNT16[i] = POPCOUNT16[i >> 1]! + (i & 1);
}

/** Parse a 16-character hex string into hash words. Throws on invalid input. */
export function parseHash(hex: string): HashWords {
  if (typeof hex !== "string" || !HEX_PATTERN.test(hex)) {
    throw new Error(
      `invalid perceptual hash: expected 16 hex characters, got ${JSON.stringify(hex)}`,
    );
  }
  // All 64 bits participate, including the most significant bit; parsing via
  // 16-bit chunks avoids any sign issues with 32/64-bit arithmetic.
  return [
    parseInt(hex.slice(12, 16), 16),
    parseInt(hex.slice(8, 12), 16),
    parseInt(hex.slice(4, 8), 16),
    parseInt(hex.slice(0, 4), 16),
  ];
}

/** Exact Hamming distance between two 64-bit hashes (0..64). */
export function hammingDistance(a: HashWords, b: HashWords): number {
  return (
    POPCOUNT16[(a[0] ^ b[0]) & 0xffff]! +
    POPCOUNT16[(a[1] ^ b[1]) & 0xffff]! +
    POPCOUNT16[(a[2] ^ b[2]) & 0xffff]! +
    POPCOUNT16[(a[3] ^ b[3]) & 0xffff]!
  );
}

/** Format hash words back to the canonical 16-character hex text. */
export function formatHash(words: HashWords): string {
  let out = "";
  for (let i = 3; i >= 0; i--) {
    out += words[i]!.toString(16).padStart(4, "0");
  }
  return out;
}

/** Lookup table: number of set bits in a 16-bit value. */
export { POPCOUNT16 };
