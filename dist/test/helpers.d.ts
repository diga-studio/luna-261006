import type { BlacklistEntry, HashWords, VerifyResult } from "../src/index.js";
export declare function mulberry32(seed: number): () => number;
export declare function randomWords(rng: () => number): HashWords;
export declare function randomHex(rng: () => number): string;
export declare function flipBits(hex: string, positions: readonly number[]): string;
export declare function randomDistinctPositions(rng: () => number, count: number): number[];
/** Reference implementation: full exact scan of the live blacklist. */
export declare class BruteForce {
    readonly records: Map<number, HashWords>;
    add(entries: readonly BlacklistEntry[]): void;
    remove(evidenceIds: readonly number[]): void;
    verify(hex: string): VerifyResult;
}
