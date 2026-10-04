import { createHash } from 'node:crypto';

/**
 * 密文信封格式（全部大端）：
 *   magic(4) | version(1) | batchHash(16) | nonce(12) | ciphertext(...) | tag(16)
 * batchHash 为批次标识 SHA-256 的前 16 字节，用于无密钥识别本批次最终密文。
 */

const MAGIC = Buffer.from([0x53, 0x56, 0x4c, 0x54]); // "SVLT"
const VERSION = 1;

export const HEADER_BYTES = 4 + 1 + 16 + 12; // 33
export const TAG_BYTES = 16;

export interface EnvelopeHeader {
  batchHash: Buffer;
  nonce: Buffer;
}

export function batchHashOf(batchId: string): Buffer {
  return createHash('sha256').update(batchId, 'utf8').digest().subarray(0, 16);
}

export function encodeHeader(header: EnvelopeHeader): Buffer {
  const out = Buffer.allocUnsafe(HEADER_BYTES);
  MAGIC.copy(out, 0);
  out.writeUInt8(VERSION, 4);
  header.batchHash.copy(out, 5);
  header.nonce.copy(out, 21);
  return out;
}

/** 若 buf 是合法信封头则返回解析结果，否则返回 null。 */
export function decodeHeader(buf: Buffer): EnvelopeHeader | null {
  if (buf.length < HEADER_BYTES) return null;
  if (!buf.subarray(0, 4).equals(MAGIC)) return null;
  if (buf.readUInt8(4) !== VERSION) return null;
  return {
    batchHash: Buffer.from(buf.subarray(5, 21)),
    nonce: Buffer.from(buf.subarray(21, 33)),
  };
}
