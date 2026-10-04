import { deflateRawSync, crc32 as zlibCrc32 } from 'node:zlib';

export interface MemberSpec {
  name: string | Buffer;
  content: Buffer;
  method?: number;
  descriptor?: 'none' | 'signed' | 'unsigned';
  utf8?: boolean;
  fileComment?: Buffer;
  /** 中央目录 extra 原始字节 */
  extra?: Buffer;
  /** 本地头 extra 原始字节 */
  localExtra?: Buffer;
  /** 篡改：中央目录使用不同名称 */
  cdName?: Buffer;
  cdCrc?: number;
  cdCompressedSize?: number;
  cdUncompressedSize?: number;
  /** 篡改：中央目录指向的本地头偏移 */
  cdLocalHeaderOffset?: number;
  flagsOverride?: number;
  /** 篡改：本地头三字段（描述符场景默认写 0） */
  localCrc?: number;
  localCompressedSize?: number;
  localUncompressedSize?: number;
  /** 篡改：压缩数据后追加的未声明字节 */
  trailingBytesAfterData?: Buffer;
  /** 篡改：复用指定序号成员的本地记录，自己不写本地头 */
  shareLocalOf?: number;
}

export interface ZipOptions {
  archiveComment?: Buffer;
  /** 中央目录写出顺序（成员索引），默认顺序 */
  cdOrder?: number[];
  prefix?: Buffer;
  suffix?: Buffer;
}

const SIG_LFH = 0x04034b50;
const SIG_CEN = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DD = 0x08074b50;

/** 用 Node 内置 zlib 独立计算 CRC-32（与被测库的实现无关） */
export function independentCrc32(data: Buffer): number {
  return zlibCrc32(data) >>> 0;
}

export function buildZip(members: MemberSpec[], opts: ZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const cdRecords: { index: number; record: Buffer }[] = [];
  const localOffsets: number[] = [];
  let offset = opts.prefix ? opts.prefix.length : 0;
  if (opts.prefix) parts.push(opts.prefix);

  members.forEach((m, idx) => {
    const name = typeof m.name === 'string' ? Buffer.from(m.name, 'utf8') : m.name;
    const method = m.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(m.content) : Buffer.from(m.content);
    const crc = independentCrc32(m.content);
    const descriptor = m.descriptor ?? 'none';
    const hasDd = descriptor !== 'none';
    const flags = m.flagsOverride ?? ((hasDd ? 0x08 : 0) | (m.utf8 ? 0x0800 : 0));
    if (m.shareLocalOf !== undefined) {
      localOffsets[idx] = localOffsets[m.shareLocalOf];
    } else {
    const localExtra = m.localExtra ?? Buffer.alloc(0);

    const lCrc = hasDd ? (m.localCrc ?? 0) : (m.localCrc ?? crc);
    const lComp = hasDd ? (m.localCompressedSize ?? 0) : (m.localCompressedSize ?? compressed.length);
    const lUncomp = hasDd ? (m.localUncompressedSize ?? 0) : (m.localUncompressedSize ?? m.content.length);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(SIG_LFH, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(lCrc, 14);
    lfh.writeUInt32LE(lComp, 18);
    lfh.writeUInt32LE(lUncomp, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(localExtra.length, 28);

    localOffsets[idx] = offset;
    const record = [lfh, name, localExtra, compressed];
    if (m.trailingBytesAfterData) record.push(m.trailingBytesAfterData);
    if (hasDd) {
      const dd = Buffer.alloc(descriptor === 'signed' ? 16 : 12);
      let p = 0;
      if (descriptor === 'signed') {
        dd.writeUInt32LE(SIG_DD, 0);
        p = 4;
      }
      dd.writeUInt32LE(crc, p);
      dd.writeUInt32LE(compressed.length, p + 4);
      dd.writeUInt32LE(m.content.length, p + 8);
      record.push(dd);
    }
    for (const r of record) {
      parts.push(r);
      offset += r.length;
    }
    }

    const cdName = m.cdName ?? name;
    const cdExtra = m.extra ?? Buffer.alloc(0);
    const fileComment = m.fileComment ?? Buffer.alloc(0);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(m.cdCrc ?? crc, 16);
    cen.writeUInt32LE(m.cdCompressedSize ?? compressed.length, 20);
    cen.writeUInt32LE(m.cdUncompressedSize ?? m.content.length, 24);
    cen.writeUInt16LE(cdName.length, 28);
    cen.writeUInt16LE(cdExtra.length, 30);
    cen.writeUInt16LE(fileComment.length, 32);
    cen.writeUInt32LE(m.cdLocalHeaderOffset ?? localOffsets[idx], 42);
    cdRecords.push({ index: idx, record: Buffer.concat([cen, cdName, cdExtra, fileComment]) });
  });

  const cdOffset = offset;
  const order = opts.cdOrder ?? members.map((_, i) => i);
  const byIndex = new Map(cdRecords.map((r) => [r.index, r.record]));
  let cdSize = 0;
  for (const i of order) {
    const rec = byIndex.get(i)!;
    parts.push(rec);
    cdSize += rec.length;
    offset += rec.length;
  }

  const comment = opts.archiveComment ?? Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  parts.push(eocd, comment);
  if (opts.suffix) parts.push(opts.suffix);

  return Buffer.concat(parts);
}
