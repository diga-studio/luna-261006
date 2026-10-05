import {
  canonicalJson,
  entryHash,
  eraseLeafHash,
  recordLeafHash,
  subjectHmac,
} from "./hash.js";
import { GENESIS_HASH, Storage, StoredEntry } from "./storage.js";
import type {
  AppendResult,
  Credential,
  EraseResult,
  RecordView,
  VerifyResult,
} from "./types.js";

/** 防篡改审计账本。 */
export class Ledger {
  private storage: Storage;
  private ledgerId: string;
  private secret: string;

  private constructor(path: string) {
    this.storage = new Storage(path);
    const meta = this.storage.loadMeta();
    this.ledgerId = meta.ledgerId;
    this.secret = meta.secret;
  }

  /** 打开（或创建）位于指定 SQLite 文件路径的账本。 */
  static open(path: string): Ledger {
    return new Ledger(path);
  }

  close(): void {
    this.storage.close();
  }

  /** 追加一条业务记录，返回序号与新的可信凭据。 */
  append(subject: string, body: unknown): AppendResult {
    const seq = this.storage.nextSeq();
    const bodyCanonical = canonicalJson(body);
    const leaf = recordLeafHash(seq, subject, bodyCanonical);
    const prev = this.storage.lastEntryHash();
    const entry: StoredEntry = {
      seq,
      kind: "record",
      subject,
      body: bodyCanonical,
      subjectHash: subjectHmac(this.secret, subject),
      leafHash: leaf,
      prevHash: prev,
      entryHash: entryHash(prev, leaf),
      erasedSeqs: null,
      erased: 0,
    };
    this.storage.appendEntry(entry);
    return { seq, credential: this.currentCredential() };
  }

  /** 擦除该主体当前全部存活记录；无匹配时账本与凭据不变。 */
  erase(subject: string): EraseResult {
    const subjectHash = subjectHmac(this.secret, subject);
    const live = this.storage.liveRecordsBySubjectHash(subjectHash);
    if (live.length === 0) {
      return { erased: false, erasedSeqs: [], credential: this.currentCredential() };
    }
    const erasedSeqs = live.map((entry) => entry.seq);
    this.storage.tombstone(erasedSeqs);
    const seq = this.storage.nextSeq();
    const leaf = eraseLeafHash(seq, subjectHash, erasedSeqs);
    const prev = this.storage.lastEntryHash();
    this.storage.appendEntry({
      seq,
      kind: "erase",
      subject: null,
      body: null,
      subjectHash,
      leafHash: leaf,
      prevHash: prev,
      entryHash: entryHash(prev, leaf),
      erasedSeqs: JSON.stringify(erasedSeqs),
      erased: 0,
    });
    return { erased: true, erasedSeqs, credential: this.currentCredential() };
  }

  /** 当前最新凭据。 */
  currentCredential(): Credential {
    return {
      ledgerId: this.ledgerId,
      length: this.storage.entryCount(),
      headHash: this.storage.lastEntryHash(),
    };
  }

  /** 按序号升序返回全部存活业务记录。 */
  records(): RecordView[] {
    return this.storage.liveRecords().map((entry) => ({
      seq: entry.seq,
      subject: entry.subject as string,
      body: JSON.parse(entry.body as string),
    }));
  }

  /** 依据 SQLite 数据与调用方提供的凭据核验账本。 */
  verify(credential: Credential): VerifyResult {
    try {
      return this.doVerify(credential);
    } catch (err) {
      return { ok: false, reason: "verify error: " + String(err) };
    }
  }

  private doVerify(credential: Credential): VerifyResult {
    if (credential.ledgerId !== this.ledgerId) {
      return fail("credential ledger id mismatch");
    }
    const entries = this.storage.allEntries();

    // 序号必须是从 1 开始连续递增的，缺失即视为被非法删除。
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].seq !== i + 1) {
        return fail("sequence gap or reordering detected at seq " + (i + 1));
      }
    }

    // 重放整条哈希链，并校验每个条目的叶子承诺。
    const erasedRecordSeqs = new Set<number>();
    const eraseEvents: { subjectHash: string; seqs: number[] }[] = [];
    let prev = GENESIS_HASH;
    for (const entry of entries) {
      let leaf: string;
      if (entry.kind === "record") {
        if (entry.erased) {
          if (entry.subject !== null || entry.body !== null) {
            return fail("erased record still carries plaintext at seq " + entry.seq);
          }
          if (entry.subjectHash === null) {
            return fail("erased record missing subject hash at seq " + entry.seq);
          }
          leaf = entry.leafHash;
          erasedRecordSeqs.add(entry.seq);
        } else {
          if (entry.subject === null || entry.body === null || entry.subjectHash === null) {
            return fail("live record missing content at seq " + entry.seq);
          }
          leaf = recordLeafHash(entry.seq, entry.subject, entry.body);
          if (leaf !== entry.leafHash) {
            return fail("record content tampered at seq " + entry.seq);
          }
          if (subjectHmac(this.secret, entry.subject) !== entry.subjectHash) {
            return fail("record subject hash mismatch at seq " + entry.seq);
          }
        }
      } else if (entry.kind === "erase") {
        if (entry.subjectHash === null || entry.erasedSeqs === null) {
          return fail("erase event incomplete at seq " + entry.seq);
        }
        let seqs: unknown;
        try {
          seqs = JSON.parse(entry.erasedSeqs);
        } catch {
          return fail("erase event payload unparsable at seq " + entry.seq);
        }
        if (
          !Array.isArray(seqs) ||
          seqs.length === 0 ||
          !seqs.every((s) => Number.isInteger(s) && s > 0)
        ) {
          return fail("erase event payload invalid at seq " + entry.seq);
        }
        leaf = eraseLeafHash(entry.seq, entry.subjectHash, seqs as number[]);
        if (leaf !== entry.leafHash) {
          return fail("erase event tampered at seq " + entry.seq);
        }
        eraseEvents.push({ subjectHash: entry.subjectHash, seqs: seqs as number[] });
      } else {
        return fail("unknown entry kind at seq " + entry.seq);
      }
      if (entry.prevHash !== prev) {
        return fail("chain link broken at seq " + entry.seq);
      }
      const expected = entryHash(prev, leaf);
      if (expected !== entry.entryHash) {
        return fail("entry hash mismatch at seq " + entry.seq);
      }
      prev = entry.entryHash;
    }

    // 擦除覆盖性：被擦除记录必须被某个擦除事件覆盖，且主体哈希一致；
    // 擦除事件引用的每条记录也必须确实已被擦除，防止伪造擦除事实。
    const covered = new Map<number, string>();
    for (const event of eraseEvents) {
      for (const seq of event.seqs) {
        covered.set(seq, event.subjectHash);
      }
    }
    const bySeq = new Map(entries.map((entry) => [entry.seq, entry]));
    for (const seq of erasedRecordSeqs) {
      if (!covered.has(seq)) {
        return fail("record erased without erase event at seq " + seq);
      }
      const entry = bySeq.get(seq) as StoredEntry;
      if (covered.get(seq) !== entry.subjectHash) {
        return fail("erase event subject mismatch for seq " + seq);
      }
    }
    for (const [seq, eventSubjectHash] of covered) {
      const entry = bySeq.get(seq);
      if (!entry || entry.kind !== "record") {
        return fail("erase event references non-record seq " + seq);
      }
      if (!entry.erased) {
        return fail("erase event references live record at seq " + seq);
      }
      if (entry.subjectHash !== eventSubjectHash) {
        return fail("erase event subject mismatch for seq " + seq);
      }
    }

    // 前缀检查：凭据覆盖的前缀必须原样存在且链头一致。
    if (credential.length > entries.length) {
      return fail("ledger truncated: credential covers " + credential.length +
        " entries but only " + entries.length + " present");
    }
    const headAt =
      credential.length === 0 ? GENESIS_HASH : entries[credential.length - 1].entryHash;
    if (headAt !== credential.headHash) {
      return fail("head hash mismatch at credential prefix");
    }
    return { ok: true, reason: null };
  }
}

function fail(reason: string): VerifyResult {
  return { ok: false, reason };
}
