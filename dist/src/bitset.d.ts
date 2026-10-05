/** Bitset helpers over Uint32Array words. */
export declare function createBitset(size: number): Uint32Array;
export declare function setBit(bits: Uint32Array, index: number): void;
export declare function getBit(bits: Uint32Array, index: number): boolean;
export declare function andInto(dst: Uint32Array, src: Uint32Array): void;
export declare function orInto(dst: Uint32Array, src: Uint32Array): void;
/** dst = ~src, restricted to the low `size` bits. */
export declare function notInto(dst: Uint32Array, src: Uint32Array, size: number): void;
export declare function cloneBitset(src: Uint32Array): Uint32Array;
