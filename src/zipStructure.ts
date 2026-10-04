import { isUtf8 } from 'node:buffer';
import type { ReasonCode } from './types.ts';
import { METHOD_STORE, METHOD_DEFLATE } from './types.ts';

const SIG_LFH = 0x04034b50;
const SIG_CEN = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DD = 0x08074b50;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const FLAG_ALLOWED = FLAG_DESCRIPTOR | FLAG_UTF8;

const EXTRA_ZIP64 = 0x0001;
const EXTRA_UNICODE_PATH = 0x7075;

/** 完成结构校验后的成员视图（本地记录与中央目录已配对一致） */
export interface Member {
  rawName: Buffer;
  method: number;
  flags: number;
  /** 以下为中央目录声明值（数据描述符场景已与描述符核对一致） */
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  /** 压缩数据在文件中的起点 */
  dataOffset: number;
  isDirectory: boolean;
}

export interface ZipStructure {
  members: Member[];
}

export type ParseResult =
  | { ok: true; structure: ZipStructure }
  | { ok: false; reasons: ReasonCode[] };

interface CentralEntry {
  offset: number;
  rawName: Buffer;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

type Fail = { ok: false; reasons: ReasonCode[] };
const fail = (reason: ReasonCode): Fail => ({ ok: false, reasons: [reason] });

/** 校验 extra 字段边界完整，并识别必须复核的字段 id。 */
function checkExtra(buf: Buffer, start: number, length: number): ReasonCode | null {
  let pos = start;
  const end = start + length;
  while (pos < end) {
    if (pos + 4 > end) return 'extra-field-truncated';
    const id = buf.readUInt16LE(pos);
    const size = buf.readUInt16LE(pos + 2);
    pos += 4;
    if (pos + size > end) return 'extra-field-truncated';
    if (id === EXTRA_ZIP64) return 'zip64';
    if (id === EXTRA_UNICODE_PATH) return 'unicode-path-extra';
    pos += size;
  }
  return null;
}

/** 校验标志位与名称编码。 */
function checkFlagsAndName(flags: number, rawName: Buffer): ReasonCode | null {
  if (flags & FLAG_ENCRYPTED) return 'encrypted';
  if (flags & ~FLAG_ALLOWED & 0xffff) return 'unsupported-flags';
  if (flags & FLAG_UTF8) {
    if (!isUtf8(rawName)) return 'non-ascii-name';
  } else {
    for (let i = 0; i < rawName.length; i++) {
      if (rawName[i] >= 0x80) return 'non-ascii-name';
    }
  }
  return null;
}

export function parseZipStructure(buf: Buffer): ParseResult {
  const len = buf.length;

  // 1. 定位 EOCD：从尾部向前找签名，要求注释长度恰好使记录结束于文件末尾，
  //    因此注释中出现的签名字节不会被误认。
  let eocdOffset = -1;
  const minPos = Math.max(0, len - 22 - 0xffff);
  for (let i = len - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD && i + 22 + buf.readUInt16LE(i + 20) === len) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return fail('not-a-zip');

  const diskNumber = buf.readUInt16LE(eocdOffset + 4);
  const cdStartDisk = buf.readUInt16LE(eocdOffset + 6);
  const entriesThisDisk = buf.readUInt16LE(eocdOffset + 8);
  const entriesTotal = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || cdStartDisk !== 0 || entriesThisDisk !== entriesTotal) {
    return fail('multi-volume');
  }
  if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return fail('zip64');
  }
  if (cdOffset + cdSize > eocdOffset) return fail('eocd-invalid');

  // 2. 解析中央目录，条目必须连续填满 CD 区间。
  const centrals: CentralEntry[] = [];
  const cdEnd = cdOffset + cdSize;
  let pos = cdOffset;
  for (let n = 0; n < entriesTotal; n++) {
    if (pos + 46 > cdEnd || buf.readUInt32LE(pos) !== SIG_CEN) {
      return fail('central-directory-invalid');
    }
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const recordLen = 46 + nameLen + extraLen + commentLen;
    if (pos + recordLen > cdEnd) return fail('central-directory-invalid');

    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      return fail('unsupported-compression');
    }
    if (
      crc === 0xffffffff ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      return fail('zip64');
    }
    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen);
    const nameProblem = checkFlagsAndName(flags, rawName);
    if (nameProblem) return fail(nameProblem);
    const extraProblem = checkExtra(buf, pos + 46 + nameLen, extraLen);
    if (extraProblem) return fail(extraProblem);

    centrals.push({
      offset: pos,
      rawName: Buffer.from(rawName),
      method,
      flags,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    pos += recordLen;
  }
  if (pos !== cdEnd) return fail('central-directory-invalid');

  // 3. 每个中央条目对应唯一本地记录；多个条目共用同一偏移即复核。
  const seenOffsets = new Set<number>();
  for (const c of centrals) {
    if (seenOffsets.has(c.localHeaderOffset)) return fail('shared-local-record');
    seenOffsets.add(c.localHeaderOffset);
  }

  // 4. 解析本地记录并与中央条目核对。
  const members: Member[] = [];
  const intervals: { start: number; end: number }[] = [];
  for (const c of centrals) {
    const off = c.localHeaderOffset;
    if (off + 30 > len || buf.readUInt32LE(off) !== SIG_LFH) {
      return fail('local-header-invalid');
    }
    const flags = buf.readUInt16LE(off + 6);
    const method = buf.readUInt16LE(off + 8);
    const lCrc = buf.readUInt32LE(off + 14);
    const lComp = buf.readUInt32LE(off + 18);
    const lUncomp = buf.readUInt32LE(off + 22);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const headerSize = 30 + nameLen + extraLen;
    if (off + headerSize > len) return fail('local-header-invalid');

    const rawName = buf.subarray(off + 30, off + 30 + nameLen);
    if (flags !== c.flags || method !== c.method || !rawName.equals(c.rawName)) {
      return fail('local-central-mismatch');
    }
    const extraProblem = checkExtra(buf, off + 30 + nameLen, extraLen);
    if (extraProblem) return fail(extraProblem);

    const hasDescriptor = (flags & FLAG_DESCRIPTOR) !== 0;
    if (!hasDescriptor) {
      if (lCrc !== c.crc || lComp !== c.compressedSize || lUncomp !== c.uncompressedSize) {
        return fail('local-central-mismatch');
      }
    } else {
      // 使用描述符时本地头三字段可分别为零或真实值
      const fieldsOk =
        (lCrc === 0 || lCrc === c.crc) &&
        (lComp === 0 || lComp === c.compressedSize) &&
        (lUncomp === 0 || lUncomp === c.uncompressedSize);
      if (!fieldsOk) return fail('local-central-mismatch');
    }

    const dataOffset = off + headerSize;
    const dataEnd = dataOffset + c.compressedSize;
    if (dataEnd > len) return fail('local-header-invalid');

    let endOffset = dataEnd;
    if (hasDescriptor) {
      // 有签名（16 字节）与无签名（12 字节）描述符都支持；
      // 不能仅凭签名前缀判定——无签名描述符的 CRC 可能恰好等于签名值，
      // 必须以字段值与中央目录一致来消歧。
      let descLen = 0;
      if (dataEnd + 16 <= len && buf.readUInt32LE(dataEnd) === SIG_DD) {
        const dCrc = buf.readUInt32LE(dataEnd + 4);
        const dComp = buf.readUInt32LE(dataEnd + 8);
        const dUncomp = buf.readUInt32LE(dataEnd + 12);
        if (dCrc === c.crc && dComp === c.compressedSize && dUncomp === c.uncompressedSize) {
          descLen = 16;
        }
      }
      if (descLen === 0 && dataEnd + 12 <= len) {
        const dCrc = buf.readUInt32LE(dataEnd);
        const dComp = buf.readUInt32LE(dataEnd + 4);
        const dUncomp = buf.readUInt32LE(dataEnd + 8);
        if (dCrc === c.crc && dComp === c.compressedSize && dUncomp === c.uncompressedSize) {
          descLen = 12;
        }
      }
      if (descLen === 0) return fail('descriptor-mismatch');
      endOffset = dataEnd + descLen;
    }

    intervals.push({ start: off, end: endOffset });
    members.push({
      rawName: c.rawName,
      method: c.method,
      flags: c.flags,
      crc: c.crc,
      compressedSize: c.compressedSize,
      uncompressedSize: c.uncompressedSize,
      dataOffset,
      isDirectory: c.rawName.length > 0 && c.rawName[c.rawName.length - 1] === 0x2f,
    });
  }

  // 5. 覆盖性：本地记录、中央目录、EOCD（含注释）必须无缝覆盖整个文件，
  //    彼此不重叠，不接受前置、尾随或无归属字节。
  intervals.push({ start: cdOffset, end: cdEnd });
  intervals.push({ start: eocdOffset, end: len });
  intervals.sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const iv of intervals) {
    if (iv.start < cursor) return fail('record-overlap');
    if (iv.start > cursor) return fail('unaccounted-bytes');
    cursor = iv.end;
  }
  if (cursor !== len) return fail('unaccounted-bytes');

  return { ok: true, structure: { members } };
}
