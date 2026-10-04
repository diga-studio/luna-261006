import { deflateRawSync } from 'node:zlib';

/** 与 src/crc32 相互独立的逐位 CRC-32 实现，用于核对。 */
export function crc32Independent(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i];
    for (let k = 0; k < 8; k += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) !== 0 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface EntrySpec {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
  /** 数据描述符形式；默认不使用 */
  descriptor?: 'none' | 'signed' | 'unsigned';
  /** 使用描述符时本地头三个字段的取值；默认全零 */
  descriptorLocalValues?: 'zero' | 'real';
  comment?: Buffer;
  /** 是否设置 UTF-8 标志；默认名称含非 ASCII 时设置 */
  utf8?: boolean;
  /** 在压缩数据末尾附加的垃圾字节数（声明的压缩长度包含它们） */
  padCompressed?: number;
  /** 覆盖声明的展开长度（默认真实长度） */
  declaredUncompressedSize?: number;
  /** 原样写入本地头与中央目录的额外字段字节 */
  extra?: Buffer;
}

export interface BuiltZip {
  buffer: Buffer;
  /** 各成员的本地头偏移（按 entries 顺序） */
  localOffsets: number[];
  /** 各成员的中央目录记录偏移（按 entries 顺序） */
  centralOffsets: number[];
  eocdOffset: number;
}

export function buildZip(
  entries: EntrySpec[],
  opts?: { archiveComment?: Buffer; centralOrder?: number[] },
): BuiltZip {
  const archiveComment = opts && opts.archiveComment ? opts.archiveComment : Buffer.alloc(0);
  const order = opts && opts.centralOrder ? opts.centralOrder : entries.map((_, i) => i);

  interface Prepared {
    nameBytes: Buffer;
    flags: number;
    method: number;
    crc: number;
    compData: Buffer;
    uncompressedSize: number;
    comment: Buffer;
    extra: Buffer;
    descriptor: 'none' | 'signed' | 'unsigned';
    descriptorLocalValues: 'zero' | 'real';
  }

  const prepared: Prepared[] = entries.map((e) => {
    const data = e.data ? e.data : Buffer.alloc(0);
    const method = e.method === undefined ? 8 : e.method;
    const nameBytes = Buffer.from(e.name, 'utf8');
    const hasNonAscii = nameBytes.some((b) => b > 0x7f);
    const utf8 = e.utf8 === undefined ? hasNonAscii : e.utf8;
    const descriptor = e.descriptor === undefined ? 'none' : e.descriptor;
    let flags = 0;
    if (descriptor !== 'none') flags |= 0x0008;
    if (utf8) flags |= 0x0800;
    const realComp = method === 8 ? deflateRawSync(data) : Buffer.from(data);
    const compData = e.padCompressed
      ? Buffer.concat([realComp, Buffer.alloc(e.padCompressed, 0x41)])
      : realComp;
    return {
      nameBytes,
      flags,
      method,
      crc: crc32Independent(data),
      compData,
      uncompressedSize:
        e.declaredUncompressedSize === undefined ? data.length : e.declaredUncompressedSize,
      comment: e.comment ? e.comment : Buffer.alloc(0),
      extra: e.extra ? e.extra : Buffer.alloc(0),
      descriptor,
      descriptorLocalValues:
        e.descriptorLocalValues === undefined ? 'zero' : e.descriptorLocalValues,
    };
  });

  const localParts: Buffer[] = [];
  const localOffsets: number[] = [];
  let offset = 0;
  for (const p of prepared) {
    localOffsets.push(offset);
    const useDescriptor = p.descriptor !== 'none';
    const localCrc = useDescriptor && p.descriptorLocalValues === 'zero' ? 0 : p.crc;
    const localComp =
      useDescriptor && p.descriptorLocalValues === 'zero' ? 0 : p.compData.length;
    const localUncomp =
      useDescriptor && p.descriptorLocalValues === 'zero' ? 0 : p.uncompressedSize;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(p.flags, 6);
    header.writeUInt16LE(p.method, 8);
    header.writeUInt32LE(localCrc, 14);
    header.writeUInt32LE(localComp, 18);
    header.writeUInt32LE(localUncomp, 22);
    header.writeUInt16LE(p.nameBytes.length, 26);
    header.writeUInt16LE(p.extra.length, 28);
    const parts = [header, p.nameBytes, p.extra, p.compData];
    if (useDescriptor) {
      const desc = Buffer.alloc(p.descriptor === 'signed' ? 16 : 12);
      let at = 0;
      if (p.descriptor === 'signed') {
        desc.writeUInt32LE(0x08074b50, 0);
        at = 4;
      }
      desc.writeUInt32LE(p.crc, at);
      desc.writeUInt32LE(p.compData.length, at + 4);
      desc.writeUInt32LE(p.uncompressedSize, at + 8);
      parts.push(desc);
    }
    const record = Buffer.concat(parts);
    localParts.push(record);
    offset += record.length;
  }
  const localBlob = Buffer.concat(localParts);

  const centralOffsets: number[] = new Array<number>(prepared.length).fill(0);
  const centralParts: Buffer[] = [];
  let centralOffset = localBlob.length;
  for (const index of order) {
    const p = prepared[index];
    centralOffsets[index] = centralOffset;
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(p.flags, 8);
    header.writeUInt16LE(p.method, 10);
    header.writeUInt32LE(p.crc, 16);
    header.writeUInt32LE(p.compData.length, 20);
    header.writeUInt32LE(p.uncompressedSize, 24);
    header.writeUInt16LE(p.nameBytes.length, 28);
    header.writeUInt16LE(p.extra.length, 30);
    header.writeUInt16LE(p.comment.length, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(localOffsets[index], 42);
    const record = Buffer.concat([header, p.nameBytes, p.extra, p.comment]);
    centralParts.push(record);
    centralOffset += record.length;
  }
  const centralBlob = Buffer.concat(centralParts);

  const eocdOffset = localBlob.length + centralBlob.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(prepared.length, 8);
  eocd.writeUInt16LE(prepared.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16);
  eocd.writeUInt16LE(archiveComment.length, 20);

  return {
    buffer: Buffer.concat([localBlob, centralBlob, eocd, archiveComment]),
    localOffsets,
    centralOffsets,
    eocdOffset,
  };
}

/**
 * 求 4 字节序列使其 CRC-32 等于 target（中途相遇，线性可逆）。
 * 用于构造“无签名描述符的 CRC 恰好等于签名值”的测试数据。
 */
export function findCrcPreimage(target: number): Buffer {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  const topByteToIndex = new Map<number, number>();
  for (let j = 0; j < 256; j += 1) topByteToIndex.set(table[j] >>> 24, j);
  const backward = (state: number, input: number): number => {
    const j = topByteToIndex.get(state >>> 24);
    if (j === undefined) throw new Error('crc table top bytes not a permutation');
    return (((state ^ table[j]) << 8) | (j ^ input)) >>> 0;
  };
  const targetState = (target ^ 0xffffffff) >>> 0;
  const forward = new Map<number, number>();
  for (let x1 = 0; x1 < 256; x1 += 1) {
    for (let x2 = 0; x2 < 256; x2 += 1) {
      let s = 0xffffffff;
      s = (table[(s ^ x1) & 0xff] ^ (s >>> 8)) >>> 0;
      s = (table[(s ^ x2) & 0xff] ^ (s >>> 8)) >>> 0;
      forward.set(s, (x1 << 8) | x2);
    }
  }
  for (let x4 = 0; x4 < 256; x4 += 1) {
    for (let x3 = 0; x3 < 256; x3 += 1) {
      const mid = backward(backward(targetState, x4), x3);
      const hit = forward.get(mid);
      if (hit !== undefined) {
        return Buffer.from([(hit >> 8) & 0xff, hit & 0xff, x3, x4]);
      }
    }
  }
  throw new Error('no crc preimage found');
}
