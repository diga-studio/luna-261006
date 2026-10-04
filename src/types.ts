/** A 64-bit perceptual hash encoded as exactly 16 lowercase/uppercase hex characters. */
export type HexHash = string;

/** A single blacklist entry to insert or replace. */
export interface BlacklistEntry {
  /** Unique positive integer evidence identifier. */
  evidenceId: number;
  /** 64-bit perceptual hash as 16 hex characters. */
  hash: HexHash;
}

/** A successful verification hit: the single best citable evidence. */
export interface VerifyHit {
  /** Evidence identifier of the best matching blacklist record. */
  evidenceId: number;
  /** Exact Hamming distance between the query hash and the matched record (0..6). */
  distance: number;
}

/**
 * Result of verifying one image hash.
 * `null` means no blacklist record within distance 6 exists.
 */
export type VerifyResult = VerifyHit | null;

/** Maximum Hamming distance (inclusive) that counts as a hit. */
export const MAX_HIT_DISTANCE = 6;
