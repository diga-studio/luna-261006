import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;
export const TOKEN_LEN = 16;

function hmac(key: Buffer, data: Buffer | string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * 加密与内容标记。
 * 调用方提供 32 字节密钥，派生出加密子密钥与标记子密钥；密钥本身不落盘。
 */
export class MessageCipher {
  private readonly encKey: Buffer;
  private readonly tokenKey: Buffer;
  private readonly checkKey: Buffer;

  constructor(masterKey: Uint8Array) {
    if (masterKey.length !== 32) {
      throw new Error("master key must be 32 bytes");
    }
    const master = Buffer.from(masterKey);
    this.encKey = hmac(master, "vaultchat/enc");
    this.tokenKey = hmac(master, "vaultchat/token");
    this.checkKey = hmac(master, "vaultchat/check");
  }

  /** 随机化认证加密（AES-256-GCM，随机 IV），返回 iv||tag||ciphertext；正文按 UTF-16LE 编码以无损往返任意 JS 字符串 */
  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.encKey, iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf16le"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, body]);
  }

  decrypt(blob: Buffer): string {
    const iv = blob.subarray(0, IV_LEN);
    const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const body = blob.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", this.encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf16le");
  }

  /** 对单个 UTF-16 code unit 计算内容标记（HMAC），泄露相等关系 */
  tokenForCodeUnit(unit: number): Buffer {
    const buf = Buffer.allocUnsafe(2);
    buf.writeUInt16LE(unit);
    return hmac(this.tokenKey, buf).subarray(0, TOKEN_LEN);
  }

  /** 对一串 UTF-16 code unit 计算标记序列（拼接） */
  tokensForString(normalized: string): Buffer {
    const out = Buffer.allocUnsafe(normalized.length * TOKEN_LEN);
    for (let i = 0; i < normalized.length; i++) {
      this.tokenForCodeUnit(normalized.charCodeAt(i)).copy(out, i * TOKEN_LEN);
    }
    return out;
  }

  /** 用于重开时校验密钥是否一致的验证值（可落盘） */
  keyCheckValue(): Buffer {
    return hmac(this.checkKey, "vaultchat/key-check").subarray(0, 16);
  }
}
