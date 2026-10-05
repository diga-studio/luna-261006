import { hammingDistance, parseHash } from "../src/index.js";
import { formatHash } from "../src/hash.js";
import type { BlacklistEntry, HashWords, VerifyResult } from "../src/index.js";

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomWords(rng: () => number): HashWords {
  return [
    Math.floor(rng() * 0x10000),
    Math.floor(rng() * 0x10000),
    Math.floor(rng() * 0x10000),
    Math.floor(rng() * 0x10000),
  ];
}

export function randomHex(rng: () => number): string {
  return formatHash(randomWords(rng));
}

export function flipBits(hex: string, positions: readonly number[]): string {
  const words = parseHash(hex);
  const mutable: number[] = [...words];
  for (const pos of positions) {
    const word = pos >>> 4;
    mutable[word] = (mutable[word]! ^ (1 << (pos & 15))) & 0xffff;
  }
  return formatHash(mutable as unknown as HashWords);
}

export function randomDistinctPositions(
  rng: () => number,
  count: number,
): number[] {
  const chosen = new Set<number>();
  while (chosen.size < count) {
    chosen.add(Math.floor(rng() * 64));
  }
  return [...chosen];
}

/** Reference implementation: full exact scan of the live blacklist. */
export class BruteForce {
  readonly records = new Map<number, HashWords>();

  add(entries: readonly BlacklistEntry[]): void {
    for (const entry of entries) {
      this.records.set(entry.evidenceId, parseHash(entry.hash));
    }
  }

  remove(evidenceIds: readonly number[]): void {
    for (const id of evidenceIds) {
      this.records.delete(id);
    }
  }

  verify(hex: string): VerifyResult {
    const query = parseHash(hex);
    let best: VerifyResult = null;
    for (const [evidenceId, words] of this.records) {
      const distance = hammingDistance(query, words);
      if (distance > 6) {
        continue;
      }
      if (
        best === null ||
        distance < best.distance ||
        (distance === best.distance && evidenceId < best.evidenceId)
      ) {
        best = { evidenceId, distance };
      }
    }
    return best;
  }
}
