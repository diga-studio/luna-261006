import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "./canon.js";
import { genesisState, hashAppendOp, hashEraseOp, hashRecord } from "./hash.js";
import type { AppendResult, Credential, EraseResult, LiveRecord, VerifyResult } from "./types.js";

const STATE_KEY = "state_hash";
const OP_COUNT_KEY = "op_count";
const RECORD_COUNT_KEY = "record_count";

interface RecordRow {
  seq: number;
  subject: string | null;
  body: string | null;
  record_hash: string;
  erased: number;
}

interface OpRow {
  op_seq: number;
  kind: string;
  payload: string;
  state_hash: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * 防篡改审计账本。
 *
 * 持久化结构：
 * - records：每条记录一行。存活行保存明文与内容承诺哈希；擦除后变为
 *   墓碑（subject/body 置空），仅保留承诺哈希作为完整性材料。
 * - ops：仅追加的操作日志（append / erase），每条携带链式状态哈希。
 *   凭据即 (opCount, recordCount, stateHash)，提交到日志前缀。
 *
 * 核验不信任 meta 缓存，重放全部操作日志并与 records 表逐行对账。
 */
export class AuditLedger {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 打开（必要时创建）位于指定 SQLite 文件路径的账本。 */
  static open(path: string): AuditLedger {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        seq INTEGER PRIMARY KEY,
        subject TEXT,
        body TEXT,
        record_hash TEXT NOT NULL,
        erased INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops (
        op_seq INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        state_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const ledger = new AuditLedger(db);
    if (ledger.metaGet(OP_COUNT_KEY) === null) {
      ledger.metaSet(OP_COUNT_KEY, "0");
      ledger.metaSet(RECORD_COUNT_KEY, "0");
      ledger.metaSet(STATE_KEY, genesisState());
    }
    return ledger;
  }

  /** 按给定顺序追加记录，返回分配的序号与新凭据。 */
  append(subject: string, body: unknown): AppendResult {
    const canonical = canonicalJson(body);
    this.db.exec("BEGIN");
    try {
      const seq = this.metaInt(RECORD_COUNT_KEY) + 1;
      const recordHash = hashRecord(seq, subject, canonical);
      this.db
        .prepare("INSERT INTO records (seq, subject, body, record_hash, erased) VALUES (?, ?, ?, ?, 0)")
        .run(seq, subject, canonical, recordHash);
      const opSeq = this.metaInt(OP_COUNT_KEY) + 1;
      const stateHash = hashAppendOp(this.metaStr(STATE_KEY), seq, recordHash);
      this.db
        .prepare("INSERT INTO ops (op_seq, kind, payload, state_hash) VALUES (?, 'append', ?, ?)")
        .run(opSeq, JSON.stringify({ seq, hash: recordHash }), stateHash);
      this.metaSet(RECORD_COUNT_KEY, String(seq));
      this.metaSet(OP_COUNT_KEY, String(opSeq));
      this.metaSet(STATE_KEY, stateHash);
      this.db.exec("COMMIT");
      return { seq, credential: this.currentCredential() };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 擦除该主体当前全部存活记录；无匹配时账本与凭据不变。 */
  eraseSubject(subject: string): EraseResult {
    this.db.exec("BEGIN");
    try {
      const rows = this.db
        .prepare("SELECT seq FROM records WHERE subject = ? AND erased = 0 ORDER BY seq")
        .all(subject) as unknown as Array<{ seq: number }>;
      if (rows.length === 0) {
        this.db.exec("COMMIT");
        return { erased: 0, credential: this.currentCredential() };
      }
      const seqs = rows.map((r) => r.seq);
      const mark = this.db.prepare(
        "UPDATE records SET subject = NULL, body = NULL, erased = 1 WHERE seq = ?",
      );
      for (const seq of seqs) mark.run(seq);
      const opSeq = this.metaInt(OP_COUNT_KEY) + 1;
      const stateHash = hashEraseOp(this.metaStr(STATE_KEY), seqs);
      this.db
        .prepare("INSERT INTO ops (op_seq, kind, payload, state_hash) VALUES (?, 'erase', ?, ?)")
        .run(opSeq, JSON.stringify({ seqs }), stateHash);
      this.metaSet(OP_COUNT_KEY, String(opSeq));
      this.metaSet(STATE_KEY, stateHash);
      this.db.exec("COMMIT");
      return { erased: seqs.length, credential: this.currentCredential() };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 依据 SQLite 数据与调用方提供的凭据核验账本。 */
  verify(credential: Credential): VerifyResult {
    const shapeError = checkCredentialShape(credential);
    if (shapeError !== null) return { ok: false, reason: shapeError };

    const ops = this.db
      .prepare("SELECT op_seq, kind, payload, state_hash FROM ops ORDER BY op_seq")
      .all() as unknown as OpRow[];
    for (let i = 0; i < ops.length; i++) {
      if (ops[i]!.op_seq !== i + 1) {
        return { ok: false, reason: "操作日志序号不连续（可能被截断或插入）" };
      }
    }
    if (ops.length < credential.opCount) {
      return { ok: false, reason: "操作日志短于凭据覆盖范围（末尾被截断或整体回滚）" };
    }

    // 重放全部操作，重建记录视图与状态链。
    const view = new Map<number, { hash: string; erased: boolean }>();
    let state = genesisState();
    let recordCount = 0;
    let stateAtCredential: string | null = credential.opCount === 0 ? state : null;
    let recordCountAtCredential: number | null = credential.opCount === 0 ? 0 : null;
    for (const op of ops) {
      if (op.kind === "append") {
        const payload = parseAppendPayload(op.payload);
        if (payload === null) return { ok: false, reason: `操作 ${op.op_seq} 的追加负载非法` };
        if (payload.seq !== recordCount + 1) {
          return { ok: false, reason: `操作 ${op.op_seq} 的记录序号不连续` };
        }
        if (!HEX64.test(payload.hash)) {
          return { ok: false, reason: `操作 ${op.op_seq} 的记录哈希格式非法` };
        }
        recordCount = payload.seq;
        view.set(payload.seq, { hash: payload.hash, erased: false });
        state = hashAppendOp(state, payload.seq, payload.hash);
      } else if (op.kind === "erase") {
        const seqs = parseErasePayload(op.payload);
        if (seqs === null) return { ok: false, reason: `操作 ${op.op_seq} 的擦除负载非法` };
        for (const seq of seqs) {
          const entry = view.get(seq);
          if (entry === undefined || entry.erased) {
            return { ok: false, reason: `操作 ${op.op_seq} 擦除了不存在或已擦除的记录` };
          }
          entry.erased = true;
        }
        state = hashEraseOp(state, seqs);
      } else {
        return { ok: false, reason: `操作 ${op.op_seq} 类型未知` };
      }
      if (op.state_hash !== state) {
        return { ok: false, reason: `操作 ${op.op_seq} 的状态哈希与重放结果不符` };
      }
      if (op.op_seq === credential.opCount) {
        stateAtCredential = state;
        recordCountAtCredential = recordCount;
      }
    }

    if (stateAtCredential === null || stateAtCredential !== credential.stateHash) {
      return { ok: false, reason: "凭据状态哈希与重放结果不符" };
    }
    if (recordCountAtCredential !== credential.recordCount) {
      return { ok: false, reason: "凭据记录数与重放结果不符" };
    }

    // 将重放视图与 records 表逐行对账（覆盖全部操作，含凭据之后合法演化的部分）。
    const rows = this.db
      .prepare("SELECT seq, subject, body, record_hash, erased FROM records ORDER BY seq")
      .all() as unknown as RecordRow[];
    if (rows.length !== view.size) {
      return { ok: false, reason: "记录表行数与操作日志重放结果不符" };
    }
    for (const row of rows) {
      const entry = view.get(row.seq);
      if (entry === undefined) {
        return { ok: false, reason: `记录 ${row.seq} 在操作日志中不存在` };
      }
      if (row.record_hash !== entry.hash) {
        return { ok: false, reason: `记录 ${row.seq} 的承诺哈希被改动` };
      }
      if (entry.erased) {
        if (row.erased !== 1 || row.subject !== null || row.body !== null) {
          return { ok: false, reason: `记录 ${row.seq} 应为墓碑但残留明文` };
        }
      } else {
        if (row.erased !== 0 || row.subject === null || row.body === null) {
          return { ok: false, reason: `记录 ${row.seq} 缺失且不存在合法擦除事实` };
        }
        let canonical: string;
        try {
          canonical = canonicalJson(JSON.parse(row.body));
        } catch {
          return { ok: false, reason: `记录 ${row.seq} 的正文不是合法 JSON` };
        }
        if (hashRecord(row.seq, row.subject, canonical) !== row.record_hash) {
          return { ok: false, reason: `记录 ${row.seq} 的主体或正文被篡改` };
        }
      }
    }
    return { ok: true };
  }

  /** 当前最新凭据。 */
  currentCredential(): Credential {
    return {
      version: 1,
      opCount: this.metaInt(OP_COUNT_KEY),
      recordCount: this.metaInt(RECORD_COUNT_KEY),
      stateHash: this.metaStr(STATE_KEY),
    };
  }

  /** 读取一条存活记录；不存在或已擦除时返回 null。 */
  getLiveRecord(seq: number): LiveRecord | null {
    const row = this.db
      .prepare("SELECT seq, subject, body FROM records WHERE seq = ? AND erased = 0")
      .get(seq) as unknown as { seq: number; subject: string; body: string } | undefined;
    if (row === undefined) return null;
    return { seq: row.seq, subject: row.subject, body: JSON.parse(row.body) };
  }

  /** 列出全部存活记录（按序号升序）。 */
  listLiveRecords(): LiveRecord[] {
    const rows = this.db
      .prepare("SELECT seq, subject, body FROM records WHERE erased = 0 ORDER BY seq")
      .all() as unknown as Array<{ seq: number; subject: string; body: string }>;
    return rows.map((row) => ({ seq: row.seq, subject: row.subject, body: JSON.parse(row.body) }));
  }

  close(): void {
    this.db.close();
  }

  private metaGet(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as unknown as { value: string } | undefined;
    return row === undefined ? null : row.value;
  }

  private metaSet(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  private metaStr(key: string): string {
    const value = this.metaGet(key);
    if (value === null) throw new Error(`meta 缺少键 ${key}`);
    return value;
  }

  private metaInt(key: string): number {
    return Number.parseInt(this.metaStr(key), 10);
  }
}

function checkCredentialShape(credential: Credential): string | null {
  if (credential === null || typeof credential !== "object") return "凭据不是对象";
  if (credential.version !== 1) return "凭据版本不支持";
  if (!Number.isInteger(credential.opCount) || credential.opCount < 0) return "凭据 opCount 非法";
  if (!Number.isInteger(credential.recordCount) || credential.recordCount < 0) {
    return "凭据 recordCount 非法";
  }
  if (typeof credential.stateHash !== "string" || !HEX64.test(credential.stateHash)) {
    return "凭据 stateHash 非法";
  }
  return null;
}

function parseAppendPayload(payload: string): { seq: number; hash: string } | null {
  try {
    const parsed = JSON.parse(payload) as { seq?: unknown; hash?: unknown };
    if (
      typeof parsed.seq !== "number" ||
      !Number.isInteger(parsed.seq) ||
      parsed.seq < 1 ||
      typeof parsed.hash !== "string"
    ) {
      return null;
    }
    return { seq: parsed.seq, hash: parsed.hash };
  } catch {
    return null;
  }
}

function parseErasePayload(payload: string): number[] | null {
  try {
    const parsed = JSON.parse(payload) as { seqs?: unknown };
    if (!Array.isArray(parsed.seqs) || parsed.seqs.length === 0) return null;
    const seqs: number[] = [];
    for (const item of parsed.seqs) {
      if (typeof item !== "number" || !Number.isInteger(item) || item < 1) return null;
      seqs.push(item);
    }
    const sorted = [...seqs].sort((a, b) => a - b);
    for (let i = 0; i < seqs.length; i++) {
      if (seqs[i] !== sorted[i]) return null; // 必须按升序提交
      if (i > 0 && seqs[i] === seqs[i - 1]) return null; // 不允许重复
    }
    return seqs;
  } catch {
    return null;
  }
}
