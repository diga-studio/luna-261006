import { VerifyError } from './errors.js';
import type { FileReader } from './reader.js';

/** moov 元数据上限：正常输入元数据不超过 1 MiB，留 2 倍余量保护内存。 */
export const MAX_MOOV_SIZE = 2 << 20;

/** 一个 MP4 box 的边界信息（不含内容解释）。 */
export interface BoxInfo {
  type: string;
  /** box 头部起始文件偏移（相对其所在的缓冲/文件）。 */
  start: bigint;
  /** 头部字节数（8 或 16；uuid 再加 16）。 */
  headerSize: bigint;
  /** 整个 box 的字节数（含头部）。 */
  size: bigint;
}

export function payloadStart(box: BoxInfo): bigint {
  return box.start + box.headerSize;
}

export function payloadEnd(box: BoxInfo): bigint {
  return box.start + box.size;
}

/**
 * 从字节缓冲解析 [start, end) 内的 box 序列边界。
 * 支持普通/扩展长度、末尾长度为 0 的 box；未知类型只检查边界合法。
 */
export function parseBoxSequence(buf: Buffer, start: number, end: number): BoxInfo[] {
  const boxes: BoxInfo[] = [];
  let pos = start;
  while (pos < end) {
    if (end - pos < 8) {
      throw new VerifyError('BOX_STRUCTURE', `trailing ${end - pos} bytes too small for box header`);
    }
    const size32 = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let headerSize = 8;
    let boxSize: bigint;
    if (size32 === 1) {
      if (end - pos < 16) {
        throw new VerifyError('BOX_STRUCTURE', `box ${type} truncated extended length`);
      }
      boxSize = buf.readBigUInt64BE(pos + 8);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = BigInt(end - pos);
    } else {
      boxSize = BigInt(size32);
    }
    if (type === 'uuid') {
      headerSize += 16;
    }
    if (boxSize < BigInt(headerSize)) {
      throw new VerifyError('BOX_STRUCTURE', `box ${type} size ${boxSize} smaller than header`);
    }
    if (boxSize > BigInt(end - pos)) {
      throw new VerifyError('BOX_STRUCTURE', `box ${type} overruns parent: size=${boxSize}`);
    }
    boxes.push({ type, start: BigInt(pos), headerSize: BigInt(headerSize), size: boxSize });
    pos += Number(boxSize);
  }
  return boxes;
}

/** 解析文件 [start, end) 范围内的顶层 box 序列（小步读取，不缓存全文件）。 */
export async function parseTopLevel(reader: FileReader, start: bigint, end: bigint): Promise<BoxInfo[]> {
  const boxes: BoxInfo[] = [];
  let pos = start;
  while (pos < end) {
    if (end - pos < 8n) {
      throw new VerifyError('BOX_STRUCTURE', `trailing ${end - pos} bytes too small for box header`);
    }
    const headLen = end - pos < 16n ? Number(end - pos) : 16;
    const head = await reader.readAt(pos, headLen);
    const size32 = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let headerSize = 8n;
    let boxSize: bigint;
    if (size32 === 1) {
      if (headLen < 16) {
        throw new VerifyError('BOX_STRUCTURE', `box ${type} truncated extended length`);
      }
      boxSize = head.readBigUInt64BE(8);
      headerSize = 16n;
    } else if (size32 === 0) {
      boxSize = end - pos;
    } else {
      boxSize = BigInt(size32);
    }
    if (type === 'uuid') {
      headerSize += 16n;
    }
    if (boxSize < headerSize) {
      throw new VerifyError('BOX_STRUCTURE', `box ${type} size ${boxSize} smaller than header`);
    }
    if (boxSize > end - pos) {
      throw new VerifyError('BOX_STRUCTURE', `box ${type} overruns file: size=${boxSize}`);
    }
    boxes.push({ type, start: pos, headerSize, size: boxSize });
    pos += boxSize;
  }
  return boxes;
}

/** 读取整个 moov（含头部）到内存，受 MAX_MOOV_SIZE 限制。 */
export async function readMoov(reader: FileReader, moov: BoxInfo): Promise<Buffer> {
  if (moov.size > BigInt(MAX_MOOV_SIZE)) {
    throw new VerifyError('UNSUPPORTED', `moov too large: ${moov.size} bytes`);
  }
  return reader.readAt(moov.start, Number(moov.size));
}

/** 在 moov 缓冲内解析指定容器 box 的直接子 box（偏移均为缓冲相对）。 */
export function childrenOf(moovBuf: Buffer, container: BoxInfo): BoxInfo[] {
  return parseBoxSequence(moovBuf, Number(payloadStart(container)), Number(payloadEnd(container)));
}
