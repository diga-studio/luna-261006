import { createHash } from 'node:crypto';
import { open, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrustedManifest } from '../src/types.js';

export interface FixtureOptions {
  frameRate?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  mediaTimescale?: number;
  movieTimescale?: number;
  /** elst 媒体起点（帧数）；>0 时写入 elst。 */
  mediaStartFrames?: number;
  /** elst 片段个数（默认 1）。 */
  elstEntries?: number;
  /** elst 播放速率整数部分（默认 1）。 */
  elstRate?: number;
  /** elst 版本（默认 0）。 */
  elstVersion?: 0 | 1;
  /** 使用 B 帧重排（解码序 != 展示序）。 */
  bFrames?: boolean;
  cttsVersion?: 0 | 1;
  framesPerChunk?: number;
  mdatCount?: number;
  moovFirst?: boolean;
  useCo64?: boolean;
  /** stsz 使用定长模式（样本尺寸恒定）。 */
  fixedStsz?: boolean;
  /** 在首个 mdat 前插入 free，使载荷起点达到该偏移。 */
  padMdatTo?: bigint;
  /** 块写入顺序反转（文件位置不递增）。 */
  shuffleChunks?: boolean;
  headerVersion?: 0 | 1;
  /** 末尾 mdat 使用长度 0（延伸到文件尾）。 */
  lastMdatSizeZero?: boolean;
  mdhdDurationDelta?: bigint;
  mvhdDurationDelta?: bigint;
  tkhdDurationDelta?: bigint;
  elstDurationDelta?: bigint;
  /** 让第一个块指向 mdat 之外。 */
  corruptChunkOffset?: boolean;
  /** 让前两个样本展示时刻相同。 */
  duplicatePts?: boolean;
  /** stsz 多写几个样本长度（计数不一致）。 */
  stszExtraCount?: number;
  /** 文件末尾追加 8 字节空 free box。 */
  trailingEmptyFree?: boolean;
  seed?: number;
}

export interface Fixture {
  path: string;
  manifest: TrustedManifest;
  frameDuration: bigint;
  mediaTimescale: number;
  /** 展示顺序各帧的展示时刻（媒体时间尺度），独立按置换算出。 */
  presentationTimes: bigint[];
}

function be16(v: number): Buffer {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16BE(v);
  return b;
}

function be32(v: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(v);
  return b;
}

function beI32(v: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeInt32BE(v);
  return b;
}

function be64(v: bigint): Buffer {
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64BE(v);
  return b;
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const size = 8 + parts.reduce((a, p) => a + p.length, 0);
  return Buffer.concat([be32(size), Buffer.from(type, 'latin1'), ...parts]);
}

/** 扩展长度（16 字节头）的 box。 */
function boxWide(type: string, size: bigint, head: Buffer): Buffer {
  return Buffer.concat([be32(1), Buffer.from(type, 'latin1'), be64(size), head]);
}

function fullBox(type: string, version: number, flags: number, ...parts: Buffer[]): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt8(version, 0);
  b.writeUIntBE(flags, 1, 3);
  return box(type, b, ...parts);
}

const MATRIX = Buffer.concat([
  be32(0x00010000), be32(0), be32(0),
  be32(0), be32(0x00010000), be32(0),
  be32(0), be32(0), be32(0x40000000),
]);

function sampleData(seed: number, i: number, size: number): Buffer {
  const out = Buffer.allocUnsafe(size);
  let off = 0;
  let counter = 0;
  while (off < size) {
    const h = createHash('sha256').update(`fixture-${seed}-${i}-${counter++}`).digest();
    const n = Math.min(32, size - off);
    h.copy(out, off, 0, n);
    off += n;
  }
  return out;
}

/** B 帧重排：每 4 帧一块 [I,P,B,B] → 解码序 [0,3,1,2]，余数自然序。 */
function decodeOrder(count: number, bFrames: boolean): number[] {
  const order: number[] = [];
  if (!bFrames) {
    for (let i = 0; i < count; i++) order.push(i);
    return order;
  }
  let i = 0;
  while (i + 4 <= count) {
    order.push(i, i + 3, i + 1, i + 2);
    i += 4;
  }
  while (i < count) order.push(i++);
  return order;
}

function rle(values: bigint[]): Array<[number, bigint]> {
  const out: Array<[number, bigint]> = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
}

export async function buildFixture(dir: string, name: string, opts: FixtureOptions = {}): Promise<Fixture> {
  const frameRate = opts.frameRate ?? 24;
  const durationSeconds = opts.durationSeconds ?? 5;
  const width = opts.width ?? 320;
  const height = opts.height ?? 240;
  const mediaTimescale = opts.mediaTimescale ?? 90000;
  const movieTimescale = opts.movieTimescale ?? 1000;
  const mediaStartFrames = opts.mediaStartFrames ?? 0;
  const bFrames = opts.bFrames ?? false;
  const framesPerChunk = opts.framesPerChunk ?? 1;
  const mdatCount = opts.mdatCount ?? 1;
  const moovFirst = opts.moovFirst ?? false;
  const fixedStsz = opts.fixedStsz ?? false;
  const shuffleChunks = opts.shuffleChunks ?? false;
  const hv = opts.headerVersion ?? 0;
  const seed = opts.seed ?? 1;

  const frameCount = frameRate * durationSeconds;
  if (mediaTimescale % frameRate !== 0) throw new Error('timescale must divide by frame rate');
  const fd = BigInt(mediaTimescale / frameRate);
  const mediaStart = BigInt(mediaStartFrames) * fd;

  const order = decodeOrder(frameCount, bFrames);
  const sizes: number[] = [];
  const data: Buffer[] = [];
  for (let d = 0; d < frameCount; d++) {
    const size = fixedStsz ? 128 : 64 + ((d * 37 + seed * 11) % 200);
    sizes.push(size);
    data.push(sampleData(seed, d, size));
  }

  // 组合偏移：pts[d] = d*fd + ctts[d] = mediaStart + order[d]*fd
  const ctts: bigint[] = order.map((p, d) => mediaStart + (BigInt(p) - BigInt(d)) * fd);
  if (opts.duplicatePts && frameCount >= 2) {
    ctts[1] = ctts[0]! - fd;
  }
  const needCtts = bFrames || mediaStartFrames > 0 || (opts.duplicatePts ?? false);
  const minCtts = ctts.reduce((a, b) => (b < a ? b : a), 0n);
  const cttsVersion = opts.cttsVersion ?? (minCtts < 0n ? 1 : 0);
  if (cttsVersion === 0 && minCtts < 0n) throw new Error('ctts v0 cannot hold negative offsets');

  // 分块（解码顺序连续）
  const chunks: Array<{ firstSample: number; count: number }> = [];
  for (let s = 0; s < frameCount; s += framesPerChunk) {
    chunks.push({ firstSample: s, count: Math.min(framesPerChunk, frameCount - s) });
  }
  const placement = chunks.map((_, i) => i);
  if (shuffleChunks) placement.reverse();

  // 分配到各 mdat（按写入顺序连续分组）
  const groups: number[][] = [];
  const perGroup = Math.ceil(placement.length / mdatCount);
  for (let g = 0; g < mdatCount; g++) {
    groups.push(placement.slice(g * perGroup, (g + 1) * perGroup));
  }

  const GAP = 13; // 块间填充，不属于样本
  const mdatPayloads: Buffer[] = groups.map((group) => {
    const parts: Buffer[] = [];
    group.forEach((chunkIdx, k) => {
      if (k > 0) parts.push(Buffer.alloc(GAP));
      const chunk = chunks[chunkIdx]!;
      for (let s = chunk.firstSample; s < chunk.firstSample + chunk.count; s++) {
        parts.push(data[s]!);
      }
    });
    return Buffer.concat(parts);
  });

  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), be32(0x200), Buffer.from('isomiso2avc1mp41', 'latin1'));

  // co64 决策必须在布局前确定，保证两次构建 moov 尺寸一致。
  const forceCo64 =
    (opts.useCo64 ?? false) ||
    (opts.padMdatTo !== undefined && opts.padMdatTo >= 0x100000000n);

  const buildMoov = (chunkOffsets: bigint[]): Buffer => {
    const stts = fullBox('stts', hv, 0, be32(1), be32(frameCount), be32(Number(fd)));
    let cttsBox: Buffer = Buffer.alloc(0);
    if (needCtts) {
      const entries = rle(ctts);
      const parts: Buffer[] = [be32(entries.length)];
      for (const [n, v] of entries) {
        parts.push(be32(n));
        parts.push(cttsVersion === 1 ? beI32(Number(v)) : be32(Number(v)));
      }
      cttsBox = fullBox('ctts', cttsVersion, 0, ...parts);
    }
    const stscEntries = rle(chunks.map((c) => BigInt(c.count)));
    const stsc = fullBox(
      'stsc', hv, 0,
      be32(stscEntries.length),
      ...stscEntries.flatMap(([n, v], e) => {
        const firstChunk = stscEntries.slice(0, e).reduce((a, [m]) => a + m, 0) + 1;
        return [be32(firstChunk), be32(Number(v)), be32(1)];
      }),
    );
    const stszCount = frameCount + (opts.stszExtraCount ?? 0);
    let stsz: Buffer;
    if (fixedStsz) {
      stsz = fullBox('stsz', 0, 0, be32(128), be32(stszCount));
    } else {
      const entries: Buffer[] = [];
      for (let i = 0; i < stszCount; i++) entries.push(be32(sizes[Math.min(i, frameCount - 1)]!));
      stsz = fullBox('stsz', 0, 0, be32(0), be32(stszCount), ...entries);
    }
    const useCo64 = forceCo64 || chunkOffsets.some((o) => o >= 0x100000000n);
    const offsetsBox = useCo64
      ? fullBox('co64', hv, 0, be32(chunkOffsets.length), ...chunkOffsets.map((o) => be64(o)))
      : fullBox('stco', hv, 0, be32(chunkOffsets.length), ...chunkOffsets.map((o) => be32(Number(o))));

    const avc1 = box(
      'avc1',
      Buffer.alloc(6), be16(1), Buffer.alloc(16),
      be16(width), be16(height),
      be32(0x00480000), be32(0x00480000), be32(0), be16(1),
      Buffer.alloc(32), be16(0x18), be16(0xffff),
    );
    const stsd = fullBox('stsd', 0, 0, be32(1), avc1);
    const stbl = box('stbl', stsd, stts, cttsBox, stsc, stsz, offsetsBox);
    const minf = box('minf', stbl);
    const hdlr = fullBox('hdlr', 0, 0, be32(0), Buffer.from('vide', 'latin1'), be32(0), be32(0), be32(0), Buffer.from([0]));
    const mediaDuration = BigInt(frameCount) * fd + (opts.mdhdDurationDelta ?? 0n);
    const mdhd =
      hv === 0
        ? fullBox('mdhd', 0, 0, be32(0), be32(0), be32(mediaTimescale), be32(Number(mediaDuration)), be16(0x55c4), be16(0))
        : fullBox('mdhd', 1, 0, be64(0n), be64(0n), be32(mediaTimescale), be64(mediaDuration), be16(0x55c4), be16(0));
    const mdia = box('mdia', mdhd, hdlr, minf);

    const trackDuration = BigInt(durationSeconds * movieTimescale) + (opts.tkhdDurationDelta ?? 0n);
    const tkhd =
      hv === 0
        ? fullBox('tkhd', 0, 7, be32(0), be32(0), be32(1), be32(0), be32(Number(trackDuration)),
            be32(0), be32(0), be16(0), be16(0), be16(0), be16(0), MATRIX, be32(width << 16), be32(height << 16))
        : fullBox('tkhd', 1, 7, be64(0n), be64(0n), be32(1), be32(0), be64(trackDuration),
            be32(0), be32(0), be16(0), be16(0), be16(0), be16(0), MATRIX, be32(width << 16), be32(height << 16));

    let edts: Buffer = Buffer.alloc(0);
    if (mediaStartFrames > 0) {
      const entryCount = opts.elstEntries ?? 1;
      const segDur = BigInt(durationSeconds * movieTimescale) + (opts.elstDurationDelta ?? 0n);
      const ev = opts.elstVersion ?? 0;
      const parts: Buffer[] = [be32(entryCount)];
      for (let e = 0; e < entryCount; e++) {
        const mt = e === 0 ? mediaStart : 0n;
        if (ev === 1) {
          parts.push(be64(segDur));
          parts.push(be64(mt));
        } else {
          parts.push(be32(Number(segDur)));
          parts.push(be32(Number(mt)));
        }
        parts.push(be16(opts.elstRate ?? 1), be16(0));
      }
      edts = box('edts', fullBox('elst', ev, 0, ...parts));
    }
    const trak = box('trak', tkhd, edts, mdia);

    const movieDuration = BigInt(durationSeconds * movieTimescale) + (opts.mvhdDurationDelta ?? 0n);
    const mvhd =
      hv === 0
        ? fullBox('mvhd', 0, 0, be32(0), be32(0), be32(movieTimescale), be32(Number(movieDuration)),
            be32(0x00010000), be16(0x0100), be16(0), be32(0), be32(0), MATRIX, Buffer.alloc(24), be32(2))
        : fullBox('mvhd', 1, 0, be64(0n), be64(0n), be32(movieTimescale), be64(movieDuration),
            be32(0x00010000), be16(0x0100), be16(0), be32(0), be32(0), MATRIX, Buffer.alloc(24), be32(2));
    return box('moov', mvhd, trak);
  };

  // 布局：先算 moov 占位尺寸，再定各块偏移，最后重建 moov。
  const moovPlaceholder = buildMoov(chunks.map(() => 0n));
  const chunkOffsets = new Array<bigint>(chunks.length).fill(0n);
  let offset = BigInt(ftyp.length);
  let moovOffset = 0n;
  if (moovFirst) {
    moovOffset = offset;
    offset += BigInt(moovPlaceholder.length);
  }
  let freeHeader: Buffer | null = null;
  let freeOffset = 0n;
  if (opts.padMdatTo !== undefined) {
    const freeSize = opts.padMdatTo - offset;
    if (freeSize < 16n) throw new Error('padMdatTo too small for free box');
    freeHeader = boxWide('free', freeSize, Buffer.alloc(0));
    freeOffset = offset;
    offset = opts.padMdatTo;
  }
  interface Part { offset: bigint; buf: Buffer }
  const parts: Part[] = [{ offset: 0n, buf: ftyp }];
  if (freeHeader) parts.push({ offset: freeOffset, buf: freeHeader });

  groups.forEach((group, g) => {
    if (group.length === 0) return;
    const payload = mdatPayloads[g]!;
    const isLast = g === groups.length - 1 && (opts.lastMdatSizeZero ?? false);
    const header = isLast
      ? Buffer.concat([be32(0), Buffer.from('mdat', 'latin1')])
      : Buffer.concat([be32(8 + payload.length), Buffer.from('mdat', 'latin1')]);
    let p = offset + 8n;
    group.forEach((chunkIdx, k) => {
      if (k > 0) p += BigInt(GAP);
      chunkOffsets[chunkIdx] = p;
      const chunk = chunks[chunkIdx]!;
      for (let s = chunk.firstSample; s < chunk.firstSample + chunk.count; s++) {
        p += BigInt(sizes[s]!);
      }
    });
    parts.push({ offset, buf: Buffer.concat([header, payload]) });
    offset += BigInt(header.length + payload.length);
  });

  if (opts.corruptChunkOffset && chunkOffsets.length > 0) {
    chunkOffsets[0] = 64n; // 指向 ftyp 区域，不在任何 mdat 内
  }

  const moovBuf = buildMoov(chunkOffsets);
  if (moovBuf.length !== moovPlaceholder.length) {
    throw new Error('moov size changed between layout passes');
  }
  if (!moovFirst) moovOffset = offset;
  parts.push({ offset: moovOffset, buf: moovBuf });

  if (opts.trailingEmptyFree) {
    const end = parts.reduce((a, p) => {
      const e = p.offset + BigInt(p.buf.length);
      return e > a ? e : a;
    }, 0n);
    parts.push({ offset: end, buf: box('free') });
  }

  const path = join(dir, `${name}.mp4`);
  const handle = await open(path, 'w');
  try {
    for (const part of parts) {
      await handle.write(part.buf, 0, part.buf.length, Number(part.offset));
    }
  } finally {
    await handle.close();
  }

  // 清单：按展示时刻排序的样本哈希
  const pts = order.map((_, d) => BigInt(d) * fd + ctts[d]!);
  const presentation = order.map((_, d) => d).sort((a, b) => (pts[a]! < pts[b]! ? -1 : pts[a]! > pts[b]! ? 1 : 0));
  const presentationTimes = presentation.map((d) => pts[d]!);
  const frameSha256 = presentation.map((d) => createHash('sha256').update(data[d]!).digest('hex'));

  return {
    path,
    manifest: { width, height, frameRate, durationSeconds, frameSha256 },
    frameDuration: fd,
    mediaTimescale,
    presentationTimes,
  };
}

export async function makeFixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mp4verify-'));
}
