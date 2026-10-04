import { TextDecoder } from 'node:util';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;

/** 允许的通用标志位：bit1/bit2（Deflate 选项）、bit3（数据描述符）、bit11（UTF-8 名称） */
const FLAG_ALLOWED_MASK = 0x0002 | 0x0004 | 0x0008 | 0x0800;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const EXTRA_ZIP64 = 0x0001;
const EXTRA_UNICODE_PATH = 0x7075;

/** 中央目录条目（只保留检查所需字段） */
export interface CentralEntry {
  nameBytes: Buffer;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** 配对完成的成员：中央目录条目 + 本地记录中压缩数据的位置 */
export interface MemberRecord {
  central: CentralEntry;
  dataOffset: number;
  dataLength: number;
  isDirectory: boolean;
  name: string;
}

export type ParseResult =
  | { ok: true; members: MemberRecord[] }
  | { ok: false; reason: string };

function fail(reason: string): ParseResult {
  return { ok: false, reason };
}

/** 额外字段：边界必须完整；ZIP64 与 Unicode Path 改名扩展不支持。 */
function checkExtra(extra: Buffer): string | null {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) return 'extra field header truncated';
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    if (offset + 4 + size > extra.length) return 'extra field boundary error';
    if (id === EXTRA_ZIP64) return 'zip64 extra field not supported';
    if (id === EXTRA_UNICODE_PATH) return 'unicode path extra field not supported';
    offset += 4 + size;
  }
  return null;
}

function decodeName(bytes: Buffer, utf8: boolean): string | null {
  if (utf8) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] > 0x7f) return null;
  }
  return bytes.toString('latin1');
}

/**
 * 读取数据描述符，返回描述符字节数（12 无签名 / 16 有签名），不匹配返回 -1。
 * 无签名描述符的 CRC 恰好等于签名值 0x08074b50 时，两种解释都可能成立，
 * 优先按无签名解释（此时中央目录 CRC 必等于签名值）。
 */
function readDescriptor(buf: Buffer, pos: number, limit: number, central: CentralEntry): number {
  if (pos + 12 > limit) return -1;
  const matchesAt = (off: number): boolean =>
    buf.readUInt32LE(off) === central.crc &&
    buf.readUInt32LE(off + 4) === central.compressedSize &&
    buf.readUInt32LE(off + 8) === central.uncompressedSize;
  const first = buf.readUInt32LE(pos);
  if (first === SIG_DESCRIPTOR && central.crc !== SIG_DESCRIPTOR) {
    return pos + 16 <= limit && matchesAt(pos + 4) ? 16 : -1;
  }
  if (matchesAt(pos)) return 12;
  if (first === SIG_DESCRIPTOR && pos + 16 <= limit && matchesAt(pos + 4)) return 16;
  return -1;
}

/**
 * 解析并校验整个 ZIP 的结构：本地记录、中央目录、结束记录（含注释）
 * 必须完整、互不重叠地覆盖整个文件；本地记录与中央目录一一对应。
 */
export function parseZip(buf: Buffer): ParseResult {
  if (buf.length < 22) return fail('file too small for end record');

  // 定位 EOCD：从文件尾向前找签名，且注释长度必须恰好延伸到文件末尾，
  // 注释中出现的签名字节不会满足这一约束。
  let eocdPos = -1;
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD && buf.readUInt16LE(i + 20) === buf.length - 22 - i) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) return fail('end of central directory record not found');

  const diskNo = buf.readUInt16LE(eocdPos + 4);
  const cdDisk = buf.readUInt16LE(eocdPos + 6);
  const entriesOnDisk = buf.readUInt16LE(eocdPos + 8);
  const entriesTotal = buf.readUInt16LE(eocdPos + 10);
  const cdSize = buf.readUInt32LE(eocdPos + 12);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  if (diskNo !== 0 || cdDisk !== 0 || entriesOnDisk !== entriesTotal) {
    return fail('multi-disk archive not supported');
  }
  if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return fail('zip64 archive not supported');
  }
  if (cdOffset > eocdPos || cdSize > eocdPos - cdOffset) {
    return fail('central directory out of bounds');
  }
  if (cdOffset + cdSize !== eocdPos) {
    return fail('unowned bytes between central directory and end record');
  }

  // 解析中央目录
  const entries: CentralEntry[] = [];
  let pos = cdOffset;
  for (let n = 0; n < entriesTotal; n += 1) {
    if (pos + 46 > eocdPos) return fail('central directory entry truncated');
    if (buf.readUInt32LE(pos) !== SIG_CENTRAL) return fail('bad central directory signature');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const diskStart = buf.readUInt16LE(pos + 34);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    if (diskStart !== 0) return fail('multi-disk archive not supported');
    const recordLen = 46 + nameLen + extraLen + commentLen;
    if (recordLen > eocdPos - pos) return fail('central directory entry overruns directory');
    const nameBytes = Buffer.from(buf.subarray(pos + 46, pos + 46 + nameLen));
    const extra = buf.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);
    const extraError = checkExtra(extra);
    if (extraError !== null) return fail(extraError);
    entries.push({ nameBytes, flags, method, crc, compressedSize, uncompressedSize, localHeaderOffset });
    pos += recordLen;
  }
  if (pos !== eocdPos) return fail('central directory size mismatch');

  // 中央目录按本地记录偏移建索引；两个条目共用同一条本地记录即异常
  const indexByOffset = new Map<number, number>();
  for (let i = 0; i < entries.length; i += 1) {
    const off = entries[i].localHeaderOffset;
    if (off >= cdOffset) return fail('local header offset out of range');
    if (indexByOffset.has(off)) return fail('multiple central entries share one local record');
    indexByOffset.set(off, i);
  }

  // 顺序走查本地记录区，与中央目录一一配对
  const used = new Array<boolean>(entries.length).fill(false);
  const members: MemberRecord[] = [];
  pos = 0;
  while (pos < cdOffset) {
    if (pos + 30 > cdOffset) return fail('local header truncated');
    if (buf.readUInt32LE(pos) !== SIG_LOCAL) return fail('bad local header signature');
    const flags = buf.readUInt16LE(pos + 6);
    const method = buf.readUInt16LE(pos + 8);
    const crc = buf.readUInt32LE(pos + 14);
    const compressedSize = buf.readUInt32LE(pos + 18);
    const uncompressedSize = buf.readUInt32LE(pos + 22);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const headerLen = 30 + nameLen + extraLen;
    if (headerLen > cdOffset - pos) return fail('local header overruns central directory');
    const nameBytes = buf.subarray(pos + 30, pos + 30 + nameLen);
    const extra = buf.subarray(pos + 30 + nameLen, pos + 30 + nameLen + extraLen);
    const extraError = checkExtra(extra);
    if (extraError !== null) return fail(extraError);

    const index = indexByOffset.get(pos);
    if (index === undefined || used[index]) return fail('local record without matching central entry');
    const central = entries[index];
    if (!central.nameBytes.equals(nameBytes)) return fail('local and central names differ');
    if (central.method !== method || central.flags !== flags) {
      return fail('local and central method/flags differ');
    }
    if ((flags & ~FLAG_ALLOWED_MASK) !== 0) return fail('unsupported general purpose flags');
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      return fail('unsupported compression method');
    }
    if ((flags & FLAG_DESCRIPTOR) !== 0) {
      const crcOk = crc === 0 || crc === central.crc;
      const compOk = compressedSize === 0 || compressedSize === central.compressedSize;
      const uncompOk = uncompressedSize === 0 || uncompressedSize === central.uncompressedSize;
      if (!crcOk || !compOk || !uncompOk) {
        return fail('local header values conflict with central directory');
      }
    } else if (
      crc !== central.crc ||
      compressedSize !== central.compressedSize ||
      uncompressedSize !== central.uncompressedSize
    ) {
      return fail('local header values differ from central directory');
    }

    const dataOffset = pos + headerLen;
    const dataLength = central.compressedSize;
    if (dataLength > cdOffset - dataOffset) return fail('compressed data overruns central directory');
    let next = dataOffset + dataLength;
    if ((flags & FLAG_DESCRIPTOR) !== 0) {
      const descriptorLen = readDescriptor(buf, next, cdOffset, central);
      if (descriptorLen < 0) return fail('data descriptor does not match central directory');
      next += descriptorLen;
    }

    const decoded = decodeName(nameBytes, (flags & FLAG_UTF8) !== 0);
    if (decoded === null) return fail('member name encoding not accepted');
    if (decoded.length === 0) return fail('empty member name');
    const isDirectory = nameBytes.length > 0 && nameBytes[nameBytes.length - 1] === 0x2f;

    used[index] = true;
    members.push({ central, dataOffset, dataLength, isDirectory, name: decoded });
    pos = next;
  }
  if (pos !== cdOffset) return fail('local records do not abut central directory');
  if (members.length !== entries.length) return fail('central entries without local records');

  return { ok: true, members };
}
