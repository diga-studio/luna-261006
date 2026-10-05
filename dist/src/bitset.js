/** Bitset helpers over Uint32Array words. */
export function createBitset(size) {
    return new Uint32Array(Math.ceil(size / 32));
}
export function setBit(bits, index) {
    bits[index >>> 5] |= 1 << (index & 31);
}
export function getBit(bits, index) {
    return (bits[index >>> 5] & (1 << (index & 31))) !== 0;
}
export function andInto(dst, src) {
    for (let i = 0; i < dst.length; i++)
        dst[i] &= src[i];
}
export function orInto(dst, src) {
    for (let i = 0; i < dst.length; i++)
        dst[i] |= src[i];
}
/** dst = ~src, restricted to the low `size` bits. */
export function notInto(dst, src, size) {
    for (let i = 0; i < dst.length; i++)
        dst[i] = ~src[i];
    const rem = size & 31;
    if (rem !== 0 && dst.length > 0) {
        dst[dst.length - 1] &= (1 << rem) - 1;
    }
}
export function cloneBitset(src) {
    return src.slice();
}
