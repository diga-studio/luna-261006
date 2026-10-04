import { VerifyError } from './errors.js';
import { payloadStart, payloadEnd, type BoxInfo } from './boxes.js';
import type { MoovData } from './moovParse.js';

/** 单个样本（一帧对应一个 AVC 样本）。 */
export interface Sample {
  /** 样本字节在文件中的偏移。 */
  offset: bigint;
  /** 样本字节长度。 */
  size: number;
  /** 解码时刻（媒体时间尺度单位）。 */
  decodeTime: bigint;
  /** 解码持续时间（媒体时间尺度单位）。 */
  decodeDuration: bigint;
  /** 组合偏移（ctts，可正可负；缺省为 0）。 */
  compositionOffset: bigint;
}

/** mdat 载荷范围 [start, end)。 */
export interface MdatRange {
  start: bigint;
  end: bigint;
}

function u32(buf: Buffer, off: number, what: string): number {
  if (off < 0 || off + 4 > buf.length) throw new VerifyError('SAMPLE_TABLE', `${what} truncated`);
  return buf.readUInt32BE(off);
}

function entryCount(buf: Buffer, box: BoxInfo): number {
  return u32(buf, Number(payloadStart(box)) + 4, `${box.type}.entry_count`);
}

/** stsz：支持定长与逐样本长度。 */
function parseStsz(buf: Buffer, box: BoxInfo): number[] {
  const p = Number(payloadStart(box));
  const sampleSize = u32(buf, p + 4, 'stsz.sample_size');
  const count = u32(buf, p + 8, 'stsz.sample_count');
  if (sampleSize !== 0) {
    return new Array<number>(count).fill(sampleSize);
  }
  if (p + 12 + count * 4 > Number(payloadEnd(box))) {
    throw new VerifyError('SAMPLE_TABLE', 'stsz table truncated');
  }
  const sizes = new Array<number>(count);
  for (let i = 0; i < count; i++) sizes[i] = u32(buf, p + 12 + i * 4, 'stsz.entry');
  return sizes;
}

/** stco / co64：块偏移列表。 */
function parseChunkOffsets(buf: Buffer, stco: BoxInfo | null, co64: BoxInfo | null): bigint[] {
  const box = (stco ?? co64)!;
  const wide = co64 !== null;
  const p = Number(payloadStart(box));
  const count = entryCount(buf, box);
  const step = wide ? 8 : 4;
  if (p + 8 + count * step > Number(payloadEnd(box))) {
    throw new VerifyError('SAMPLE_TABLE', `${box.type} table truncated`);
  }
  const offsets = new Array<bigint>(count);
  for (let i = 0; i < count; i++) {
    offsets[i] = wide
      ? buf.readBigUInt64BE(p + 8 + i * 8)
      : BigInt(u32(buf, p + 8 + i * 4, 'stco.entry'));
  }
  return offsets;
}

/** stsc：展开为每个块的样本数。 */
function parseChunkSampleCounts(buf: Buffer, box: BoxInfo, chunkCount: number): number[] {
  const p = Number(payloadStart(box));
  const count = entryCount(buf, box);
  if (p + 8 + count * 12 > Number(payloadEnd(box))) {
    throw new VerifyError('SAMPLE_TABLE', 'stsc table truncated');
  }
  if (chunkCount === 0) {
    if (count !== 0) throw new VerifyError('SAMPLE_TABLE', 'stsc entries but no chunks');
    return [];
  }
  if (count === 0) throw new VerifyError('SAMPLE_TABLE', 'stsc empty but chunks exist');
  const perChunk = new Array<number>(chunkCount).fill(0);
  for (let e = 0; e < count; e++) {
    const base = p + 8 + e * 12;
    const firstChunk = u32(buf, base, 'stsc.first_chunk');
    const samplesPerChunk = u32(buf, base + 4, 'stsc.samples_per_chunk');
    const descIndex = u32(buf, base + 8, 'stsc.sample_description_index');
    if (descIndex !== 1) {
      throw new VerifyError('UNSUPPORTED', `stsc sample_description_index ${descIndex} != 1`);
    }
    if (samplesPerChunk === 0) {
      throw new VerifyError('SAMPLE_TABLE', 'stsc samples_per_chunk is 0');
    }
    if (firstChunk < 1 || firstChunk > chunkCount) {
      throw new VerifyError('SAMPLE_TABLE', `stsc first_chunk ${firstChunk} out of range`);
    }
    if (e === 0 && firstChunk !== 1) {
      throw new VerifyError('SAMPLE_TABLE', 'stsc first entry must start at chunk 1');
    }
    if (e > 0) {
      const prevFirst = u32(buf, p + 8 + (e - 1) * 12, 'stsc.first_chunk');
      if (firstChunk <= prevFirst) {
        throw new VerifyError('SAMPLE_TABLE', 'stsc first_chunk not increasing');
      }
    }
    const lastChunk = e + 1 < count ? u32(buf, p + 8 + (e + 1) * 12, 'stsc.first_chunk') - 1 : chunkCount;
    for (let c = firstChunk - 1; c < lastChunk; c++) perChunk[c] = samplesPerChunk;
  }
  return perChunk;
}

/** stts：每样本解码时刻与持续时间。 */
function parseStts(buf: Buffer, box: BoxInfo, sampleCount: number): { times: bigint[]; durations: bigint[] } {
  const p = Number(payloadStart(box));
  const count = entryCount(buf, box);
  if (p + 8 + count * 8 > Number(payloadEnd(box))) {
    throw new VerifyError('SAMPLE_TABLE', 'stts table truncated');
  }
  const times = new Array<bigint>(sampleCount);
  const durations = new Array<bigint>(sampleCount);
  let t = 0n;
  let idx = 0;
  for (let e = 0; e < count; e++) {
    const n = u32(buf, p + 8 + e * 8, 'stts.count');
    const delta = BigInt(u32(buf, p + 12 + e * 8, 'stts.delta'));
    for (let k = 0; k < n; k++) {
      if (idx >= sampleCount) throw new VerifyError('SAMPLE_TABLE', 'stts count exceeds sample count');
      times[idx] = t;
      durations[idx] = delta;
      t += delta;
      idx++;
    }
  }
  if (idx !== sampleCount) {
    throw new VerifyError('SAMPLE_TABLE', `stts covers ${idx} samples, expected ${sampleCount}`);
  }
  return { times, durations };
}

/** ctts：每样本组合偏移；版本 0 无符号，版本 1 有符号。 */
function parseCtts(buf: Buffer, box: BoxInfo, sampleCount: number): bigint[] {
  const p = Number(payloadStart(box));
  const version = buf.readUInt8(p);
  if (version !== 0 && version !== 1) {
    throw new VerifyError('UNSUPPORTED', `ctts version ${version}`);
  }
  const count = entryCount(buf, box);
  if (p + 8 + count * 8 > Number(payloadEnd(box))) {
    throw new VerifyError('SAMPLE_TABLE', 'ctts table truncated');
  }
  const offsets = new Array<bigint>(sampleCount);
  let idx = 0;
  for (let e = 0; e < count; e++) {
    const n = u32(buf, p + 8 + e * 8, 'ctts.count');
    const off =
      version === 1
        ? BigInt(buf.readInt32BE(p + 12 + e * 8))
        : BigInt(u32(buf, p + 12 + e * 8, 'ctts.offset'));
    for (let k = 0; k < n; k++) {
      if (idx >= sampleCount) throw new VerifyError('SAMPLE_TABLE', 'ctts count exceeds sample count');
      offsets[idx] = off;
      idx++;
    }
  }
  if (idx !== sampleCount) {
    throw new VerifyError('SAMPLE_TABLE', `ctts covers ${idx} samples, expected ${sampleCount}`);
  }
  return offsets;
}

/** 校验所有样本完整落在某个 mdat 载荷内且互不重叠。 */
function validateSamplePlacement(samples: Sample[], mdatRanges: MdatRange[]): void {
  const ranges = [...mdatRanges].sort((a, b) => (a.start < b.start ? -1 : 1));
  const byOffset = [...samples].sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
  let rangeIdx = 0;
  let prevEnd = -1n;
  for (const s of byOffset) {
    const end = s.offset + BigInt(s.size);
    if (s.offset < prevEnd) {
      throw new VerifyError('TRACK_LAYOUT', `overlapping samples at offset ${s.offset}`);
    }
    prevEnd = end;
    while (rangeIdx < ranges.length && ranges[rangeIdx]!.end <= s.offset) rangeIdx++;
    const range = ranges[rangeIdx];
    if (!range || s.offset < range.start || end > range.end) {
      throw new VerifyError('TRACK_LAYOUT', `sample at offset ${s.offset} size ${s.size} not inside any mdat payload`);
    }
  }
}

/** 由样本表构建解码顺序的样本列表，并校验样本落点。 */
export function buildSamples(moovBuf: Buffer, moov: MoovData, mdatRanges: MdatRange[]): Sample[] {
  const { stbl } = moov;
  const sizes = parseStsz(moovBuf, stbl.stsz);
  const chunkOffsets = parseChunkOffsets(moovBuf, stbl.stco, stbl.co64);
  const perChunk = parseChunkSampleCounts(moovBuf, stbl.stsc, chunkOffsets.length);

  const totalFromChunks = perChunk.reduce((a, b) => a + b, 0);
  if (totalFromChunks !== sizes.length) {
    throw new VerifyError(
      'SAMPLE_TABLE',
      `stsc implies ${totalFromChunks} samples but stsz has ${sizes.length}`,
    );
  }

  const samples: Sample[] = new Array<Sample>(sizes.length);
  let idx = 0;
  for (let c = 0; c < chunkOffsets.length; c++) {
    let offset = chunkOffsets[c]!;
    for (let k = 0; k < perChunk[c]!; k++) {
      const size = sizes[idx]!;
      samples[idx] = { offset, size, decodeTime: 0n, decodeDuration: 0n, compositionOffset: 0n };
      offset += BigInt(size);
      idx++;
    }
  }

  const { times, durations } = parseStts(moovBuf, stbl.stts, samples.length);
  const cttsOffsets = stbl.ctts
    ? parseCtts(moovBuf, stbl.ctts, samples.length)
    : new Array<bigint>(samples.length).fill(0n);
  for (let i = 0; i < samples.length; i++) {
    samples[i]!.decodeTime = times[i]!;
    samples[i]!.decodeDuration = durations[i]!;
    samples[i]!.compositionOffset = cttsOffsets[i]!;
  }

  validateSamplePlacement(samples, mdatRanges);
  return samples;
}
