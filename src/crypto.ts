/**
 * Ciphertext container format and AEAD primitives.
 *
 * Layout (all multi-byte fields big-endian):
 *   MAGIC        8 bytes   "SVLT0001"
 *   batchTag    16 bytes   HMAC-SHA256(key, "svlt-batch:" + batchId)[0:16]
 *   fileTag     16 bytes   HMAC-SHA256(key, "svlt-file:" + batchId + "\0" + path)[0:16]
 *   nonce       12 bytes   random, per encryption
 *   body        N+16 bytes AES-256-GCM(plaintext) || GCM tag, AAD = header
 *
 * The header lets recovery recognize "final ciphertext of this batch" by
 * reading only the first HEADER_LENGTH bytes, without decrypting.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { IntegrityError } from "./errors";

const MAGIC = Buffer.from("SVLT0001", "ascii");
const BATCH_TAG_LEN = 16;
const FILE_TAG_LEN = 16;
const NONCE_LEN = 12;
const GCM_TAG_LEN = 16;

export const HEADER_LENGTH = MAGIC.length + BATCH_TAG_LEN + FILE_TAG_LEN + NONCE_LEN;

export interface BatchCrypto {
  /** 16-byte tag identifying the batch, derived from key + batchId. */
  readonly batchTag: Buffer;
  /** Encrypt `plaintext` for `filePath`; returns the full container. */
  encryptContainer(filePath: string, plaintext: Buffer): Buffer;
  /**
   * True iff `header` (at least the first HEADER_LENGTH bytes of the file)
   * belongs to a final container of this batch for `filePath`.
   */
  isFinalContainer(filePath: string, header: Buffer): boolean;
  /** Verify + decrypt a full container. Throws IntegrityError on failure. */
  decryptContainer(filePath: string, container: Buffer): Buffer;
}

function hmac(key: Buffer, data: string | Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** Create the per-batch crypto context. `key` must be exactly 32 bytes. */
export function createBatchCrypto(key: Buffer, batchId: string): BatchCrypto {
  const batchTag = hmac(key, `svlt-batch:${batchId}`).subarray(0, BATCH_TAG_LEN);

  function fileTag(filePath: string): Buffer {
    return hmac(key, Buffer.concat([Buffer.from(`svlt-file:${batchId}\0`, "utf8"), Buffer.from(filePath, "utf8")])).subarray(0, FILE_TAG_LEN);
  }

  function headerFor(filePath: string, nonce: Buffer): Buffer {
    return Buffer.concat([MAGIC, batchTag, fileTag(filePath), nonce]);
  }

  return {
    batchTag,

    encryptContainer(filePath: string, plaintext: Buffer): Buffer {
      const nonce = randomBytes(NONCE_LEN);
      const header = headerFor(filePath, nonce);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(header);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([header, body, tag]);
    },

    isFinalContainer(filePath: string, header: Buffer): boolean {
      if (header.length < HEADER_LENGTH) return false;
      if (!header.subarray(0, MAGIC.length).equals(MAGIC)) return false;
      if (!header.subarray(8, 8 + BATCH_TAG_LEN).equals(batchTag)) return false;
      const tagOff = 8 + BATCH_TAG_LEN;
      return header.subarray(tagOff, tagOff + FILE_TAG_LEN).equals(fileTag(filePath));
    },

    decryptContainer(filePath: string, container: Buffer): Buffer {
      if (container.length < HEADER_LENGTH + GCM_TAG_LEN) {
        throw new IntegrityError(`file too short to be a valid container: ${filePath}`);
      }
      if (!this.isFinalContainer(filePath, container.subarray(0, HEADER_LENGTH))) {
        throw new IntegrityError(`not a final container of this batch: ${filePath}`);
      }
      const header = container.subarray(0, HEADER_LENGTH);
      const nonce = header.subarray(HEADER_LENGTH - NONCE_LEN);
      const body = container.subarray(HEADER_LENGTH, container.length - GCM_TAG_LEN);
      const tag = container.subarray(container.length - GCM_TAG_LEN);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(header);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        throw new IntegrityError(`integrity check failed: ${filePath}`);
      }
    },
  };
}
