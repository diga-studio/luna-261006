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
export declare type VerifyResult = VerifyHit | null;
/**
 * In-memory blacklist of counterfeit-image perceptual hashes.
 * Supports batch upsert, batch removal and exact batch verification
 * (hit iff Hamming distance <= 6; ties broken by smallest evidence id).
 * Not safe for concurrent use; callers invoke operations sequentially.
 */
export declare class BlacklistVerifier {
    private capacity;
    private liveCount;
    private nextInternalId;
    private readonly freeInternalIds;
    private readonly internalIdByEvidenceId;
    private hashWords;
    private evidenceIds;
    private slotPositions;
    private matchCounts;
    private touched;
    private queryEpoch;
    private readonly bands;
    private readonly scratchBandBytes;
    constructor();
    /** Number of live blacklist records. */
    get size(): number;
    /**
     * Upsert a batch of entries; an existing evidence id replaces its old hash.
     * The batch is validated before any mutation, so an invalid entry rejects
     * the whole batch.
     */
    addBatch(entries: readonly BlacklistEntry[]): void;
    /** Remove a batch of evidence ids; unknown ids are ignored. */
    removeBatch(evidenceIds: readonly number[]): void;
    /** Verify a batch of hashes, one exact result per input hash. */
    verifyBatch(hashes: readonly string[]): VerifyResult[];
    private ensureCapacity;
    private upsert;
    private removeInternal;
    private verifyOne;
}
