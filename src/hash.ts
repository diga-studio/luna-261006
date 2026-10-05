import { createHash, createHmac } from "node:crypto";

/** canonical JSON 序列化（对象键递归排序），用于哈希承诺。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(obj[key]));
  return "{" + parts.join(",") + "}";
}

/** 对任意字符串做 SHA-256，返回 hex。 */
export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** 计算业务记录的叶子哈希。 */
export function recordLeafHash(seq: number, subject: string, bodyCanonical: string): string {
  return sha256Hex("record\n" + seq + "\n" + subject + "\n" + bodyCanonical);
}

/** 计算擦除事件的叶子哈希。 */
export function eraseLeafHash(seq: number, subjectHash: string, erasedSeqs: number[]): string {
  return sha256Hex("erase\n" + seq + "\n" + subjectHash + "\n" + erasedSeqs.join(","));
}

/** 计算链式条目哈希：entryHash = H(prevHash | leafHash)。 */
export function entryHash(prevHash: string, leafHash: string): string {
  return sha256Hex("entry\n" + prevHash + "\n" + leafHash);
}

/** 主体标识的 keyed 哈希（完整性材料，非明文）。 */
export function subjectHmac(secret: string, subject: string): string {
  return createHmac("sha256", secret).update("subject\n" + subject, "utf8").digest("hex");
}
