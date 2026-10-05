/**
 * 64-bit perceptual hash represented as four 16-bit words.
 * words[0] holds bits 0..15 (least significant), words[3] holds bits 48..63.
 */
export declare type HashWords = readonly [number, number, number, number];
declare const POPCOUNT16: Uint8Array;
/** Parse a 16-character hex string into hash words. Throws on invalid input. */
export declare function parseHash(hex: string): HashWords;
/** Exact Hamming distance between two 64-bit hashes (0..64). */
export declare function hammingDistance(a: HashWords, b: HashWords): number;
/** Format hash words back to the canonical 16-character hex text. */
export declare function formatHash(words: HashWords): string;
/** Lookup table: number of set bits in a 16-bit value. */
export { POPCOUNT16 };
