/** MP4 box 结构遍历：只解析边界，不解释未知 box 内容。 */

export interface BoxHeader {
  /** 四字符类型。 */
  type: string;
  /** box 起始文件偏移（含头）。 */
  start: bigint;
  /** box 总长度（含头）。 */
  size: bigint;
  /** 头部字节数（8 或 16）。 */
  headerSize: bigint;
  /** 载荷起始 = start + headerSize。 */
  payloadStart: bigint;
  /** 载荷长度 = size - headerSize。 */
  payloadSize: bigint;
}

export interface BoxCursor {
  /** 顺序读取下一个 box 头；到达末尾返回 null。 */
  next(): Promise<BoxHeader | null>;
}

/**
 * 在 [start, end) 范围内建立 box 游标。
 * 支持普通/扩展长度以及长度为 0（延伸至范围末尾）的 box。
 */
export function openBoxRange(
  _fd: number,
  _start: bigint,
  _end: bigint
): BoxCursor {
  throw new Error('not implemented');
}

/** 容器 box 类型（需要递归进入载荷解析子 box）。 */
export const CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta',
]);
