import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  batchHashOf,
  decodeHeader,
  encodeHeader,
  HEADER_BYTES,
  TAG_BYTES,
  type EnvelopeHeader,
} from './envelope.js';

function checkKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('key must be a 32-byte Buffer');
  }
}

/** 用 32 字节密钥把原文加密为完整信封字节。 */
export function encryptEnvelope(
  key: Buffer,
  batchId: string,
  plaintext: Buffer,
): Buffer {
  checkKey(key);
  const header: EnvelopeHeader = {
    batchHash: batchHashOf(batchId),
    nonce: randomBytes(12),
  };
  const headerBytes = encodeHeader(header);
  const cipher = createCipheriv('aes-256-gcm', key, header.nonce);
  cipher.setAAD(headerBytes);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([headerBytes, body, tag]);
}

/** 解析结果：头部 + 密文主体（含尾部 tag）。 */
export function splitEnvelope(
  buf: Buffer,
): { header: EnvelopeHeader; body: Buffer } | null {
  const header = decodeHeader(buf);
  if (header === null) return null;
  if (buf.length < HEADER_BYTES + TAG_BYTES) return null;
  return { header, body: buf.subarray(HEADER_BYTES) };
}

/**
 * 解密信封主体；完整性验证失败时抛出，不返回任何明文。
 */
export function decryptEnvelope(
  key: Buffer,
  header: EnvelopeHeader,
  body: Buffer,
): Buffer {
  checkKey(key);
  if (body.length < TAG_BYTES) {
    throw new Error('ciphertext too short');
  }
  const tag = body.subarray(body.length - TAG_BYTES);
  const ciphertext = body.subarray(0, body.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, header.nonce);
  decipher.setAAD(encodeHeader(header));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('integrity check failed');
  }
}
