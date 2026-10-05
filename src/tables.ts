/** 样本表解析与展示时间轴推导。 */

/** 单个样本的解析结果。 */
export interface SampleInfo {
  /** 样本在文件中的偏移。 */
  offset: bigint;
  /** 样本字节长度。 */
  size: number;
  /** 解码时刻（媒体时间尺度单位）。 */
  decodeTime: bigint;
  /** 解码持续时间（媒体时间尺度单位）。 */
  duration: bigint;
  /** 组合偏移（ctts，有符号；缺省为 0）。 */
  compositionOffset: bigint;
}

/** stts 条目。 */
export interface SttsEntry {
  count: number;
  delta: number;
}

/** ctts 条目（v0 无符号，v1 有符号）。 */
export interface CttsEntry {
  count: number;
  offset: bigint;
}

/** stsc 条目。 */
export interface StscEntry {
  firstChunk: number;
  samplesPerChunk: number;
  sampleDescriptionIndex: number;
}

/** 解析 stts 载荷为条目数组。 */
export function parseStts(_buf: Buffer): SttsEntry[] {
  throw new Error('not implemented');
}

/** 解析 ctts 载荷为条目数组。 */
export function parseCtts(_buf: Buffer): CttsEntry[] {
  throw new Error('not implemented');
}

/** 解析 stsc 载荷为条目数组。 */
export function parseStsc(_buf: Buffer): StscEntry[] {
  throw new Error('not implemented');
}

/** 解析 stsz 载荷为逐样本长度数组（支持定长）。 */
export function parseStsz(_buf: Buffer): number[] {
  throw new Error('not implemented');
}

/** 解析 stco/co64 载荷为块偏移数组。 */
export function parseChunkOffsets(_buf: Buffer, _type: 'stco' | 'co64'): bigint[] {
  throw new Error('not implemented');
}

/**
 * 由样本表展开为逐样本信息（解码顺序）。
 * 计数不一致时抛错。
 */
export function expandSamples(
  _stts: SttsEntry[],
  _ctts: CttsEntry[] | null,
  _stsc: StscEntry[],
  _sizes: number[],
  _chunkOffsets: bigint[]
): SampleInfo[] {
  throw new Error('not implemented');
}
