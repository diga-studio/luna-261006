import { VerifyError } from './errors.js';
import { parseBoxSequence, childrenOf, payloadStart, payloadEnd, type BoxInfo } from './boxes.js';

/** stbl 中样本表相关 box 的位置（偏移为 moov 缓冲相对）。 */
export interface StblBoxes {
  stts: BoxInfo;
  ctts: BoxInfo | null;
  stsc: BoxInfo;
  stsz: BoxInfo;
  stco: BoxInfo | null;
  co64: BoxInfo | null;
}

export interface MoovData {
  movieTimescale: number;
  movieDuration: bigint;
  /** tkhd 声明的轨道时长（电影时间尺度）。 */
  trackDuration: bigint;
  mediaTimescale: number;
  /** mdhd 声明的媒体时长（媒体时间尺度）。 */
  mediaDuration: bigint;
  /** elst 媒体起点（媒体时间尺度）；无 elst 时为 0。 */
  editMediaStart: bigint;
  /** elst 片段时长（电影时间尺度）；无 elst 时为 null。 */
  editSegmentDuration: bigint | null;
  /** avc1 样本描述中的宽高。 */
  width: number;
  height: number;
  stbl: StblBoxes;
}

function u16(buf: Buffer, off: number, what: string): number {
  if (off < 0 || off + 2 > buf.length) throw new VerifyError('BOX_STRUCTURE', `${what} truncated`);
  return buf.readUInt16BE(off);
}

function u32(buf: Buffer, off: number, what: string): number {
  if (off < 0 || off + 4 > buf.length) throw new VerifyError('BOX_STRUCTURE', `${what} truncated`);
  return buf.readUInt32BE(off);
}

function u64(buf: Buffer, off: number, what: string): bigint {
  if (off < 0 || off + 8 > buf.length) throw new VerifyError('BOX_STRUCTURE', `${what} truncated`);
  return buf.readBigUInt64BE(off);
}

function i64(buf: Buffer, off: number, what: string): bigint {
  if (off < 0 || off + 8 > buf.length) throw new VerifyError('BOX_STRUCTURE', `${what} truncated`);
  return buf.readBigInt64BE(off);
}

function fullBoxVersion(buf: Buffer, box: BoxInfo): number {
  return u8(buf, Number(payloadStart(box)), `${box.type} version`);
}

function u8(buf: Buffer, off: number, what: string): number {
  if (off < 0 || off + 1 > buf.length) throw new VerifyError('BOX_STRUCTURE', `${what} truncated`);
  return buf.readUInt8(off);
}

function findChild(children: BoxInfo[], type: string): BoxInfo | null {
  return children.find((b) => b.type === type) ?? null;
}

function requireChild(children: BoxInfo[], type: string): BoxInfo {
  const box = findChild(children, type);
  if (!box) throw new VerifyError('BOX_STRUCTURE', `missing required box ${type}`);
  return box;
}

/** 解析 mvhd：返回电影时间尺度与时长。 */
function parseMvhd(buf: Buffer, box: BoxInfo): { timescale: number; duration: bigint } {
  const p = Number(payloadStart(box));
  const version = fullBoxVersion(buf, box);
  if (version === 0) {
    return { timescale: u32(buf, p + 12, 'mvhd.timescale'), duration: BigInt(u32(buf, p + 16, 'mvhd.duration')) };
  }
  if (version === 1) {
    return { timescale: u32(buf, p + 20, 'mvhd.timescale'), duration: u64(buf, p + 24, 'mvhd.duration') };
  }
  throw new VerifyError('UNSUPPORTED', `mvhd version ${version}`);
}

/** 解析 tkhd：返回轨道时长（电影时间尺度）。 */
function parseTkhd(buf: Buffer, box: BoxInfo): bigint {
  const p = Number(payloadStart(box));
  const version = fullBoxVersion(buf, box);
  if (version === 0) return BigInt(u32(buf, p + 20, 'tkhd.duration'));
  if (version === 1) return u64(buf, p + 28, 'tkhd.duration');
  throw new VerifyError('UNSUPPORTED', `tkhd version ${version}`);
}

/** 解析 mdhd：返回媒体时间尺度与时长。 */
function parseMdhd(buf: Buffer, box: BoxInfo): { timescale: number; duration: bigint } {
  const p = Number(payloadStart(box));
  const version = fullBoxVersion(buf, box);
  if (version === 0) {
    return { timescale: u32(buf, p + 12, 'mdhd.timescale'), duration: BigInt(u32(buf, p + 16, 'mdhd.duration')) };
  }
  if (version === 1) {
    return { timescale: u32(buf, p + 20, 'mdhd.timescale'), duration: u64(buf, p + 24, 'mdhd.duration') };
  }
  throw new VerifyError('UNSUPPORTED', `mdhd version ${version}`);
}

/** 解析 elst：无则返回 null；有则必须是单个 rate=1、媒体起点非负的片段。 */
function parseElst(
  buf: Buffer,
  box: BoxInfo,
): { segmentDuration: bigint; mediaTime: bigint } {
  const p = Number(payloadStart(box));
  const version = fullBoxVersion(buf, box);
  const count = u32(buf, p + 4, 'elst.entry_count');
  if (count !== 1) {
    throw new VerifyError('UNSUPPORTED', `elst must have exactly 1 entry, got ${count}`);
  }
  let segmentDuration: bigint;
  let mediaTime: bigint;
  let rateOffset: number;
  if (version === 0) {
    segmentDuration = BigInt(u32(buf, p + 8, 'elst.segment_duration'));
    mediaTime = BigInt(u32(buf, p + 12, 'elst.media_time'));
    rateOffset = p + 16;
  } else if (version === 1) {
    segmentDuration = u64(buf, p + 8, 'elst.segment_duration');
    mediaTime = i64(buf, p + 16, 'elst.media_time');
    rateOffset = p + 24;
  } else {
    throw new VerifyError('UNSUPPORTED', `elst version ${version}`);
  }
  const rateInteger = buf.readInt16BE(rateOffset);
  const rateFraction = u16(buf, rateOffset + 2, 'elst.media_rate_fraction');
  if (rateInteger !== 1 || rateFraction !== 0) {
    throw new VerifyError('UNSUPPORTED', `elst media rate must be 1, got ${rateInteger}.${rateFraction}`);
  }
  if (mediaTime < 0n) {
    throw new VerifyError('UNSUPPORTED', `elst media start must be non-negative, got ${mediaTime}`);
  }
  return { segmentDuration, mediaTime };
}

/** 解析 stsd 首个样本描述（必须为 avc1、未加密），返回宽高。 */
function parseStsd(buf: Buffer, box: BoxInfo): { width: number; height: number } {
  const p = Number(payloadStart(box));
  const entryCount = u32(buf, p + 4, 'stsd.entry_count');
  if (entryCount !== 1) {
    throw new VerifyError('UNSUPPORTED', `stsd must have exactly 1 entry, got ${entryCount}`);
  }
  const entryStart = p + 8;
  const entrySize = u32(buf, entryStart, 'stsd.entry.size');
  const format = buf.toString('latin1', entryStart + 4, entryStart + 8);
  if (format !== 'avc1') {
    throw new VerifyError('UNSUPPORTED', `sample entry format must be avc1, got ${format}`);
  }
  if (entrySize < 86 || entryStart + entrySize > Number(payloadEnd(box))) {
    throw new VerifyError('BOX_STRUCTURE', 'avc1 sample entry truncated');
  }
  // 加密轨会在样本描述内嵌 sinf/schm，一律拒绝。
  const children = parseBoxSequence(buf, entryStart + 86, entryStart + entrySize);
  for (const child of children) {
    if (child.type === 'sinf' || child.type === 'schm' || child.type === 'tenc') {
      throw new VerifyError('UNSUPPORTED', 'encrypted sample entry');
    }
  }
  return {
    width: u16(buf, entryStart + 32, 'avc1.width'),
    height: u16(buf, entryStart + 34, 'avc1.height'),
  };
}

/** 解析整个 moov 缓冲，返回核验所需的全部头信息。 */
export function parseMoov(moovBuf: Buffer): MoovData {
  const top = parseBoxSequence(moovBuf, 8, moovBuf.length);
  const mvhd = requireChild(top, 'mvhd');
  const movie = parseMvhd(moovBuf, mvhd);
  if (movie.timescale === 0) throw new VerifyError('BOX_STRUCTURE', 'mvhd timescale is 0');

  if (findChild(top, 'mvex')) {
    throw new VerifyError('UNSUPPORTED', 'fragmented MP4 (mvex) is not supported');
  }
  const traks = top.filter((b) => b.type === 'trak');
  if (traks.length !== 1) {
    throw new VerifyError('UNSUPPORTED', `expected exactly 1 track, got ${traks.length}`);
  }
  const trak = traks[0]!;
  const trakChildren = childrenOf(moovBuf, trak);
  const trackDuration = parseTkhd(moovBuf, requireChild(trakChildren, 'tkhd'));

  const mdia = requireChild(trakChildren, 'mdia');
  const mdiaChildren = childrenOf(moovBuf, mdia);
  const media = parseMdhd(moovBuf, requireChild(mdiaChildren, 'mdhd'));
  if (media.timescale === 0) throw new VerifyError('BOX_STRUCTURE', 'mdhd timescale is 0');

  const hdlr = requireChild(mdiaChildren, 'hdlr');
  const handler = moovBuf.toString('latin1', Number(payloadStart(hdlr)) + 8, Number(payloadStart(hdlr)) + 12);
  if (handler !== 'vide') {
    throw new VerifyError('UNSUPPORTED', `track handler must be vide, got ${handler}`);
  }

  let editMediaStart = 0n;
  let editSegmentDuration: bigint | null = null;
  const edts = findChild(trakChildren, 'edts');
  if (edts) {
    const elst = requireChild(childrenOf(moovBuf, edts), 'elst');
    const edit = parseElst(moovBuf, elst);
    editMediaStart = edit.mediaTime;
    editSegmentDuration = edit.segmentDuration;
  }

  const minf = requireChild(mdiaChildren, 'minf');
  const stbl = requireChild(childrenOf(moovBuf, minf), 'stbl');
  const stblChildren = childrenOf(moovBuf, stbl);
  const { width, height } = parseStsd(moovBuf, requireChild(stblChildren, 'stsd'));

  const stco = findChild(stblChildren, 'stco');
  const co64 = findChild(stblChildren, 'co64');
  if (!stco && !co64) {
    throw new VerifyError('BOX_STRUCTURE', 'missing stco/co64');
  }
  if (stco && co64) {
    throw new VerifyError('BOX_STRUCTURE', 'both stco and co64 present');
  }

  return {
    movieTimescale: movie.timescale,
    movieDuration: movie.duration,
    trackDuration,
    mediaTimescale: media.timescale,
    mediaDuration: media.duration,
    editMediaStart,
    editSegmentDuration,
    width,
    height,
    stbl: {
      stts: requireChild(stblChildren, 'stts'),
      ctts: findChild(stblChildren, 'ctts'),
      stsc: requireChild(stblChildren, 'stsc'),
      stsz: requireChild(stblChildren, 'stsz'),
      stco,
      co64,
    },
  };
}
