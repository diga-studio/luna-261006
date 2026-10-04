import { open, type FileHandle } from 'node:fs/promises';
import { VerifyError } from './errors.js';

/** 单次读取的最大字节数，限制常驻内存。 */
export const MAX_READ_CHUNK = 1 << 20; // 1 MiB

/** 只读随机访问文件读取器：小缓冲、不缓存全文件。 */
export class FileReader {
  readonly size: bigint;

  private readonly handle: FileHandle;

  private constructor(handle: FileHandle, size: bigint) {
    this.handle = handle;
    this.size = size;
  }

  static async open(path: string): Promise<FileReader> {
    let handle: FileHandle;
    try {
      handle = await open(path, 'r');
    } catch (err) {
      throw new VerifyError('IO', `cannot open file: ${(err as Error).message}`);
    }
    try {
      const stat = await handle.stat();
      return new FileReader(handle, BigInt(stat.size));
    } catch (err) {
      await handle.close();
      throw new VerifyError('IO', `cannot stat file: ${(err as Error).message}`);
    }
  }

  /** 读取 [offset, offset+length) 的字节；越界或截断时抛错。length 不得超过 MAX_READ_CHUNK。 */
  async readAt(offset: bigint, length: number): Promise<Buffer> {
    if (offset < 0n || length < 0 || offset + BigInt(length) > this.size) {
      throw new VerifyError(
        'BOX_STRUCTURE',
        `read out of range: offset=${offset} length=${length} fileSize=${this.size}`,
      );
    }
    if (length > MAX_READ_CHUNK) {
      throw new VerifyError('IO', `single read too large: ${length}`);
    }
    const buf = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await this.handle.read(
        buf,
        filled,
        length - filled,
        offset + BigInt(filled),
      );
      if (bytesRead === 0) {
        throw new VerifyError('BOX_STRUCTURE', `truncated file at offset ${offset + BigInt(filled)}`);
      }
      filled += bytesRead;
    }
    return buf;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
