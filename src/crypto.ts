import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** 随机化认证加密与检索标记派生。密钥由调用方持有，绝不落盘。 */

const KEY_LEN = 32;
const NONCE_LEN = 12;
const TOKEN_LEN = 16;
const TOKEN_PREFIX_LEN = 3;

export interface SealedBox {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_LEN) {
    throw new Error("key must be a 32-byte Uint8Array");
  }
}

function hmac(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** AES-256-GCM，随机 nonce，密文末尾附带 16 字节认证标签。 */
export function seal(key: Uint8Array, plaintext: string): SealedBox {
  assertKey(key);
  const nonce = new Uint8Array(randomBytes(NONCE_LEN));
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext: new Uint8Array(Buffer.concat([body, tag])) };
}

export function open(key: Uint8Array, box: SealedBox): string {
  assertKey(key);
  const buf = Buffer.from(box.ciphertext);
  const body = buf.subarray(0, buf.length - 16);
  const tag = buf.subarray(buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.nonce));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

function tokenFor(key: Uint8Array, slice: string): Uint8Array {
  return hmac(key, Buffer.from("vaultchat-token\0", "utf8"), Buffer.from(slice, "utf8")).subarray(
    0,
    TOKEN_LEN,
  );
}

/**
 * 由规范化正文派生检索标记集合：每个 UTF-16 位置一个标记，
 * 内容为从该位置起最多 3 个码元的前缀的 HMAC。
 * 泄露范围：长度、相等关系与位置（题目允许）。
 */
export function deriveTokens(key: Uint8Array, normalized: string): Uint8Array[] {
  assertKey(key);
  const tokens: Uint8Array[] = [];
  for (let i = 0; i < normalized.length; i++) {
    tokens.push(tokenFor(key, normalized.slice(i, i + TOKEN_PREFIX_LEN)));
  }
  return tokens;
}

/**
 * 由规范化查询派生候选过滤标记。
 * 查询作为子串出现时，其开头前缀必然出现在正文同一位置，
 * 因此用查询开头前缀的标记做过滤不会产生漏报。
 */
export function deriveQueryToken(key: Uint8Array, normalizedQuery: string): Uint8Array {
  assertKey(key);
  return tokenFor(key, normalizedQuery.slice(0, TOKEN_PREFIX_LEN));
}

/** 生成密钥校验值（可安全落盘，用于重开时校验密钥一致）。 */
export function makeKeyVerifier(key: Uint8Array): { salt: Uint8Array; verifier: Uint8Array } {
  assertKey(key);
  const salt = new Uint8Array(randomBytes(16));
  const verifier = hmac(key, Buffer.from("vaultchat-verify\0", "utf8"), salt);
  return { salt, verifier };
}

export function checkKeyVerifier(
  key: Uint8Array,
  salt: Uint8Array,
  verifier: Uint8Array,
): boolean {
  assertKey(key);
  const expect = hmac(key, Buffer.from("vaultchat-verify\0", "utf8"), salt);
  return expect.length === verifier.length && timingSafeEqual(expect, verifier);
}
