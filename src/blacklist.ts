import type { BlacklistEntry, HexHash, VerifyResult } from "./types.js";
import { MAX_HIT_DISTANCE } from "./types.js";
import { parseHexHash, popcount32 } from "./hash.js";
import { RADIUS2_DELTAS } from "./neighborhood.js";

const INITIAL_CAPACITY = 1024;

/**
 * In-memory counterfeit image blacklist verifier.
 *
 * Supports batch upsert, batch removal by evidence id, and batch
 * verification of 64-bit perceptual hashes. Verification is exact:
 * a query hits iff some live record has Hamming distance <= 6, and the
 * returned evidence is the one with the smallest distance, ties broken
 * by the smallest evidence id.
 *
 * Not safe for concurrent use; calls are expected to be sequential.
 *
 * Internally uses a multi-index exact scheme: the 64-bit hash is split
 * into four 16-bit blocks. Only the low three blocks are indexed and
 * probed with radius-2 neighborhoods. Any record within total distance
 * 6 has distance at most floor(6/3) = 2 in at least one of those three
 * blocks, so every true hit is always generated as a candidate; each
 * candidate is then verified by an exact 64-bit popcount distance.
 * Because the most significant block is never probed, workloads where
 * all hashes share the same high 16 bits degrade no worse than random
 * ones.
 */
export class BlacklistVerifier {
  private idToSlot = new Map<number, number>();
  private slotHi = new Uint32Array(INITIAL_CAPACITY);
  private slotLo = new Uint32Array(INITIAL_CAPACITY);
  private slotId = new Float64Array(INITIAL_CAPACITY);
  private slotStamp = new Uint32Array(INITIAL_CAPACITY);
  private freeSlots: number[] = [];
  private recordCount = 0;
  private capacity = INITIAL_CAPACITY;
  private stamp = 0;
  /** One exact-match index per probed 16-bit block: block value -> slots. */
  private readonly indexes: Array<Map<number, number[]>> = [
    new Map(),
    new Map(),
    new Map(),
  ];

  /** Number of live blacklist records. */
  get size(): number {
    return this.recordCount;
  }

  /**
   * Batch insert or replace blacklist entries. An entry whose evidenceId
   * already exists replaces the old hash of that id. Different ids may
   * share the same hash. Later entries in the same batch win over
   * earlier ones with the same id.
   */
  upsert(entries: readonly BlacklistEntry[]): void {
    for (const entry of entries) {
      const id = entry.evidenceId;
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error(
          `invalid evidenceId: expected a positive safe integer, got ${String(id)}`,
        );
      }
      const { hi, lo } = parseHexHash(entry.hash);
      const existing = this.idToSlot.get(id);
      if (existing !== undefined) {
        this.detachFromIndexes(existing);
        this.writeSlot(existing, id, hi, lo);
        this.attachToIndexes(existing);
      } else {
        const slot = this.allocateSlot();
        this.writeSlot(slot, id, hi, lo);
        this.idToSlot.set(id, slot);
        this.attachToIndexes(slot);
        this.recordCount++;
      }
    }
  }

  /**
   * Batch remove records by evidence id. Removing an unknown or already
   * removed id is a no-op. Removing one id never affects other ids that
   * happen to share the same hash.
   */
  remove(evidenceIds: readonly number[]): void {
    for (const id of evidenceIds) {
      const slot = this.idToSlot.get(id);
      if (slot === undefined) {
        continue;
      }
      this.detachFromIndexes(slot);
      this.idToSlot.delete(id);
      this.freeSlots.push(slot);
      this.recordCount--;
    }
  }

  /**
   * Batch verify query hashes against the current live blacklist.
   * Returns one result per query, in input order.
   */
  verify(hashes: readonly HexHash[]): VerifyResult[] {
    const results: VerifyResult[] = new Array(hashes.length);
    for (let i = 0; i < hashes.length; i++) {
      results[i] = this.verifyOne(hashes[i]!);
    }
    return results;
  }

  private verifyOne(hash: HexHash): VerifyResult {
    const { hi, lo } = parseHexHash(hash);
    const bases = [hi & 0xffff, lo >>> 16, lo & 0xffff];

    this.stamp++;
    const stamp = this.stamp;
    const slotStamp = this.slotStamp;
    const slotHi = this.slotHi;
    const slotLo = this.slotLo;
    const slotId = this.slotId;
    const deltas = RADIUS2_DELTAS;

    let bestDistance = MAX_HIT_DISTANCE + 1;
    let bestId = 0;

    for (let block = 0; block < 3; block++) {
      const index = this.indexes[block]!;
      const base = bases[block]!;
      for (let d = 0; d < deltas.length; d++) {
        const bucket = index.get(base ^ deltas[d]!);
        if (bucket === undefined) {
          continue;
        }
        for (let b = 0; b < bucket.length; b++) {
          const slot = bucket[b]!;
          if (slotStamp[slot] === stamp) {
            continue;
          }
          slotStamp[slot] = stamp;
          const distance =
            popcount32(hi ^ slotHi[slot]!) + popcount32(lo ^ slotLo[slot]!);
          if (
            distance < bestDistance ||
            (distance === bestDistance && slotId[slot]! < bestId)
          ) {
            bestDistance = distance;
            bestId = slotId[slot]!;
          }
        }
      }
    }

    if (bestDistance > MAX_HIT_DISTANCE) {
      return null;
    }
    return { evidenceId: bestId, distance: bestDistance };
  }

  private allocateSlot(): number {
    const reused = this.freeSlots.pop();
    if (reused !== undefined) {
      return reused;
    }
    // Live records plus recycled-but-still-free slots equals the number of
    // slots ever handed out, which is exactly the next fresh slot index.
    const slot = this.recordCount + this.countAllocatedFree();
    if (slot >= this.capacity) {
      this.grow();
    }
    return slot;
  }

  private countAllocatedFree(): number {
    return this.freeSlots.length;
  }

  private grow(): void {
    const next = this.capacity * 2;
    const hi = new Uint32Array(next);
    hi.set(this.slotHi);
    this.slotHi = hi;
    const lo = new Uint32Array(next);
    lo.set(this.slotLo);
    this.slotLo = lo;
    const id = new Float64Array(next);
    id.set(this.slotId);
    this.slotId = id;
    const stamp = new Uint32Array(next);
    stamp.set(this.slotStamp);
    this.slotStamp = stamp;
    this.capacity = next;
  }

  private writeSlot(slot: number, id: number, hi: number, lo: number): void {
    this.slotId[slot] = id;
    this.slotHi[slot] = hi;
    this.slotLo[slot] = lo;
  }

  private blockValues(slot: number): [number, number, number] {
    const hi = this.slotHi[slot]!;
    const lo = this.slotLo[slot]!;
    return [hi & 0xffff, lo >>> 16, lo & 0xffff];
  }

  private attachToIndexes(slot: number): void {
    const blocks = this.blockValues(slot);
    for (let block = 0; block < 3; block++) {
      const index = this.indexes[block]!;
      const key = blocks[block]!;
      const bucket = index.get(key);
      if (bucket === undefined) {
        index.set(key, [slot]);
      } else {
        bucket.push(slot);
      }
    }
  }

  private detachFromIndexes(slot: number): void {
    const blocks = this.blockValues(slot);
    for (let block = 0; block < 3; block++) {
      const index = this.indexes[block]!;
      const key = blocks[block]!;
      const bucket = index.get(key);
      if (bucket === undefined) {
        continue;
      }
      const at = bucket.indexOf(slot);
      if (at === -1) {
        continue;
      }
      const last = bucket.length - 1;
      bucket[at] = bucket[last]!;
      bucket.pop();
      if (bucket.length === 0) {
        index.delete(key);
      }
    }
  }
}
