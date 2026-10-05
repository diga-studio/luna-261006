import { parseHash, POPCOUNT16 } from "./hash.js";
import type { HashWords } from "./hash.js";

/** A single blacklist entry to upsert. */
export interface BlacklistEntry {
  /** Unique positive integer evidence id (<= Number.MAX_SAFE_INTEGER). */
  readonly evidenceId: number;
  /** 64-bit perceptual hash as 16 hex characters. */
  readonly hash: string;
}

/** Verification outcome for one queried image. */
export interface VerifyHit {
  readonly evidenceId: number;
  readonly distance: number;
}

export type VerifyResult = VerifyHit | null;

/**
 * Index design: the 64 hash bits are interleaved into 8 bands of 8 bits
 * (bit i belongs to band i % 8), so any 16 consecutive bits contribute
 * exactly 2 bits to every band. If two hashes differ in at most 6 of 64
 * positions, the differing positions touch at most 6 bands, so at least
 * 2 of the 8 band bytes are identical. Verification therefore counts, per
 * stored record, in how many band buckets it co-occurs with the query, and
 * only records reaching 2 band matches are checked with the exact Hamming
 * distance. This keeps both scattered and shared-prefix distributions exact
 * and fast.
 */
const BAND_COUNT = 8;
const BAND_VALUES = 1 << 8;
const MAX_DISTANCE = 6;
const MIN_BAND_MATCHES = BAND_COUNT - MAX_DISTANCE;
const NO_HIT = -1;

interface Bucket {
  arr: Uint32Array;
  len: number;
}

function createBucket(): Bucket {
  return { arr: new Uint32Array(4), len: 0 };
}

function validateEvidenceId(evidenceId: number): void {
  if (
    typeof evidenceId !== "number" ||
    !Number.isSafeInteger(evidenceId) ||
    evidenceId <= 0
  ) {
    throw new Error(
      `invalid evidence id: expected a positive safe integer, got ${String(evidenceId)}`,
    );
  }
}

/** Split 64 bits (four 16-bit words) into 8 interleaved band bytes. */
function computeBandBytes(
  w0: number,
  w1: number,
  w2: number,
  w3: number,
  out: Uint8Array,
): void {
  for (let b = 0; b < BAND_COUNT; b++) {
    out[b] =
      ((w0 >>> b) & 1) |
      (((w0 >>> (b + 8)) & 1) << 1) |
      (((w1 >>> b) & 1) << 2) |
      (((w1 >>> (b + 8)) & 1) << 3) |
      (((w2 >>> b) & 1) << 4) |
      (((w2 >>> (b + 8)) & 1) << 5) |
      (((w3 >>> b) & 1) << 6) |
      (((w3 >>> (b + 8)) & 1) << 7);
  }
}

/**
 * In-memory blacklist of counterfeit-image perceptual hashes.
 * Supports batch upsert, batch removal and exact batch verification
 * (hit iff Hamming distance <= 6; ties broken by smallest evidence id).
 * Not safe for concurrent use; callers invoke operations sequentially.
 */
export class BlacklistVerifier {
  private capacity = 0;
  private liveCount = 0;
  private nextInternalId = 0;
  private readonly freeInternalIds: number[] = [];
  private readonly internalIdByEvidenceId = new Map<number, number>();

  private hashWords = new Uint16Array(0); // 4 words per internal id
  private evidenceIds = new Float64Array(0); // evidence id per internal id
  private slotPositions = new Uint32Array(0); // 8 band slots per internal id
  // Scratch for verification: matchCounts packs (queryEpoch << 4) | bandHits
  // per internal id, so stale counts from previous queries need no reset
  // pass. touched lists only ids that reached the 2-band-hit threshold.
  private matchCounts = new Uint32Array(0);
  private touched = new Uint32Array(0);
  private queryEpoch = 0;

  private readonly bands: Bucket[][] = [];
  private readonly scratchBandBytes = new Uint8Array(BAND_COUNT);

  constructor() {
    for (let b = 0; b < BAND_COUNT; b++) {
      const buckets = new Array<Bucket>(BAND_VALUES);
      for (let v = 0; v < BAND_VALUES; v++) {
        buckets[v] = createBucket();
      }
      this.bands.push(buckets);
    }
    this.ensureCapacity(1024);
  }

  /** Number of live blacklist records. */
  get size(): number {
    return this.liveCount;
  }

  /**
   * Upsert a batch of entries; an existing evidence id replaces its old hash.
   * The batch is validated before any mutation, so an invalid entry rejects
   * the whole batch.
   */
  addBatch(entries: readonly BlacklistEntry[]): void {
    const parsed = new Array<HashWords>(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      validateEvidenceId(entry.evidenceId);
      parsed[i] = parseHash(entry.hash);
    }
    for (let i = 0; i < entries.length; i++) {
      this.upsert(entries[i]!.evidenceId, parsed[i]!);
    }
  }

  /** Remove a batch of evidence ids; unknown ids are ignored. */
  removeBatch(evidenceIds: readonly number[]): void {
    for (const evidenceId of evidenceIds) {
      validateEvidenceId(evidenceId);
    }
    for (const evidenceId of evidenceIds) {
      const internalId = this.internalIdByEvidenceId.get(evidenceId);
      if (internalId !== undefined) {
        this.removeInternal(internalId);
      }
    }
  }

  /** Verify a batch of hashes, one exact result per input hash. */
  verifyBatch(hashes: readonly string[]): VerifyResult[] {
    const parsed = new Array<HashWords>(hashes.length);
    for (let i = 0; i < hashes.length; i++) {
      parsed[i] = parseHash(hashes[i]!);
    }
    const results = new Array<VerifyResult>(hashes.length);
    for (let i = 0; i < hashes.length; i++) {
      results[i] = this.verifyOne(parsed[i]!);
    }
    return results;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.capacity) {
      return;
    }
    let next = Math.max(this.capacity, 1024);
    while (next < required) {
      next *= 2;
    }
    const hashWords = new Uint16Array(next * 4);
    hashWords.set(this.hashWords);
    this.hashWords = hashWords;
    const evidenceIds = new Float64Array(next);
    evidenceIds.set(this.evidenceIds);
    this.evidenceIds = evidenceIds;
    const slotPositions = new Uint32Array(next * BAND_COUNT);
    slotPositions.set(this.slotPositions);
    this.slotPositions = slotPositions;
    const matchCounts = new Uint32Array(next);
    matchCounts.set(this.matchCounts);
    this.matchCounts = matchCounts;
    const touched = new Uint32Array(next);
    touched.set(this.touched);
    this.touched = touched;
    this.capacity = next;
  }

  private upsert(evidenceId: number, words: HashWords): void {
    const existing = this.internalIdByEvidenceId.get(evidenceId);
    if (existing !== undefined) {
      this.removeInternal(existing);
    }
    const reused = this.freeInternalIds.pop();
    const internalId = reused !== undefined ? reused : this.nextInternalId++;
    this.ensureCapacity(internalId + 1);
    this.internalIdByEvidenceId.set(evidenceId, internalId);
    this.evidenceIds[internalId] = evidenceId;
    const wordOffset = internalId * 4;
    this.hashWords[wordOffset] = words[0];
    this.hashWords[wordOffset + 1] = words[1];
    this.hashWords[wordOffset + 2] = words[2];
    this.hashWords[wordOffset + 3] = words[3];
    const bandBytes = this.scratchBandBytes;
    computeBandBytes(words[0], words[1], words[2], words[3], bandBytes);
    for (let b = 0; b < BAND_COUNT; b++) {
      const bucket = this.bands[b]![bandBytes[b]!]!;
      if (bucket.len === bucket.arr.length) {
        const grown = new Uint32Array(bucket.arr.length * 2);
        grown.set(bucket.arr);
        bucket.arr = grown;
      }
      bucket.arr[bucket.len] = internalId;
      this.slotPositions[internalId * BAND_COUNT + b] = bucket.len;
      bucket.len++;
    }
    this.liveCount++;
  }

  private removeInternal(internalId: number): void {
    const wordOffset = internalId * 4;
    const bandBytes = this.scratchBandBytes;
    computeBandBytes(
      this.hashWords[wordOffset]!,
      this.hashWords[wordOffset + 1]!,
      this.hashWords[wordOffset + 2]!,
      this.hashWords[wordOffset + 3]!,
      bandBytes,
    );
    for (let b = 0; b < BAND_COUNT; b++) {
      const bucket = this.bands[b]![bandBytes[b]!]!;
      const slot = this.slotPositions[internalId * BAND_COUNT + b]!;
      const lastInternalId = bucket.arr[bucket.len - 1]!;
      bucket.arr[slot] = lastInternalId;
      this.slotPositions[lastInternalId * BAND_COUNT + b] = slot;
      bucket.len--;
    }
    this.internalIdByEvidenceId.delete(this.evidenceIds[internalId]!);
    this.freeInternalIds.push(internalId);
    this.liveCount--;
  }

  private verifyOne(words: HashWords): VerifyResult {
    const bandBytes = this.scratchBandBytes;
    const w0 = words[0];
    const w1 = words[1];
    const w2 = words[2];
    const w3 = words[3];
    computeBandBytes(w0, w1, w2, w3, bandBytes);

    this.queryEpoch++;
    if (this.queryEpoch === 0x0fffffff) {
      // The epoch packs into the high 28 bits of matchCounts; reset before
      // it could overflow into the 4 count bits.
      this.matchCounts.fill(0);
      this.queryEpoch = 1;
    }
    const epoch = this.queryEpoch;
    const epochTag = epoch * 16;
    const candidateTag = epochTag + MIN_BAND_MATCHES;

    const matchCounts = this.matchCounts;
    const touched = this.touched;
    let touchedLen = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      const bucket = this.bands[b]![bandBytes[b]!]!;
      const arr = bucket.arr;
      const len = bucket.len;
      for (let j = 0; j < len; j++) {
        const internalId = arr[j]!;
        let packed = matchCounts[internalId]!;
        if (packed >>> 4 !== epoch) {
          packed = epochTag;
        }
        packed++;
        matchCounts[internalId] = packed;
        if (packed === candidateTag) {
          touched[touchedLen++] = internalId;
        }
      }
    }

    const hashWords = this.hashWords;
    const evidenceIds = this.evidenceIds;
    let bestDistance = MAX_DISTANCE + 1;
    let bestEvidenceId = NO_HIT;
    for (let i = 0; i < touchedLen; i++) {
      const internalId = touched[i]!;
      const wordOffset = internalId * 4;
      const distance =
        POPCOUNT16[(hashWords[wordOffset]! ^ w0) & 0xffff]! +
        POPCOUNT16[(hashWords[wordOffset + 1]! ^ w1) & 0xffff]! +
        POPCOUNT16[(hashWords[wordOffset + 2]! ^ w2) & 0xffff]! +
        POPCOUNT16[(hashWords[wordOffset + 3]! ^ w3) & 0xffff]!;
      if (distance > MAX_DISTANCE) {
        continue;
      }
      const evidenceId = evidenceIds[internalId]!;
      if (
        bestEvidenceId === NO_HIT ||
        distance < bestDistance ||
        (distance === bestDistance && evidenceId < bestEvidenceId)
      ) {
        bestDistance = distance;
        bestEvidenceId = evidenceId;
      }
    }

    if (bestEvidenceId === NO_HIT) {
      return null;
    }
    return { evidenceId: bestEvidenceId, distance: bestDistance };
  }
}
