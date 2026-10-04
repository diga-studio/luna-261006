const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 增量 CRC-32（IEEE 多项式），返回无符号 32 位整数。 */
export function crc32(data: Uint8Array, crc?: number): number {
  let c = (crc === undefined ? 0 : crc) ^ 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
