import { createHash } from "node:crypto";

const GENESIS = "vaultterm-ledger:v1:genesis";

function h(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(domain);
  for (const part of parts) {
    const buf = Buffer.from(part, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length, 0);
    hash.update(len);
    hash.update(buf);
  }
  return hash.digest("hex");
}

/** 初始（空账本）状态哈希。 */
export function genesisState(): string {
  return h("vaultterm:v1:state", [GENESIS]);
}

/** 单条记录内容的承诺哈希。 */
export function hashRecord(seq: number, subject: string, canonicalBody: string): string {
  return h("vaultterm:v1:record", [String(seq), subject, canonicalBody]);
}

/** 追加操作对状态链的推进。 */
export function hashAppendOp(prevState: string, seq: number, recordHash: string): string {
  return h("vaultterm:v1:op:append", [prevState, String(seq), recordHash]);
}

/** 擦除操作对状态链的推进（按序号升序提交被擦除的记录）。 */
export function hashEraseOp(prevState: string, erasedSeqs: readonly number[]): string {
  return h("vaultterm:v1:op:erase", [prevState, ...erasedSeqs.map(String)]);
}
