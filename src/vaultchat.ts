import { DatabaseSync } from "node:sqlite";
import { openDatabase, MessageRow } from "./db.js";
import { normalizeForSearch } from "./normalize.js";
import {
  assertKey,
  checkKeyVerifier,
  deriveQueryToken,
  deriveTokens,
  makeKeyVerifier,
  open,
  seal,
} from "./crypto.js";

export interface SearchHit {
  id: number;
  conversationId: string;
  text: string;
}

export interface SearchPage {
  hits: SearchHit[];
  /** 传入下一次 search 以继续翻页；null 表示没有更多结果。 */
  cursor: number | null;
}

export interface VaultChatOptions {
  path: string;
  /** 32 字节密钥，由调用方保管，绝不落盘。 */
  key: Uint8Array;
}

const META_SALT = "key_salt";
const META_VERIFIER = "key_verifier";

export class VaultChat {
  private readonly db: DatabaseSync;
  private readonly key: Uint8Array;
  private closed = false;

  constructor(options: VaultChatOptions) {
    assertKey(options.key);
    this.key = new Uint8Array(options.key);
    this.db = openDatabase(options.path);
    const get = this.db.prepare("SELECT value FROM meta WHERE key = ?");
    const saltRow = get.get(META_SALT) as { value: Uint8Array } | undefined;
    const verifierRow = get.get(META_VERIFIER) as { value: Uint8Array } | undefined;
    if (saltRow === undefined || verifierRow === undefined) {
      const { salt, verifier } = makeKeyVerifier(this.key);
      const put = this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
      put.run(META_SALT, salt);
      put.run(META_VERIFIER, verifier);
    } else if (
      !checkKeyVerifier(
        this.key,
        new Uint8Array(saltRow.value),
        new Uint8Array(verifierRow.value),
      )
    ) {
      this.db.close();
      throw new Error("key does not match the existing database");
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("VaultChat is closed");
  }

  /** 写入正文，返回全库递增的消息 ID。 */
  append(conversationId: string, text: string): number {
    this.ensureOpen();
    const box = seal(this.key, text);
    const tokens = deriveTokens(this.key, normalizeForSearch(text));
    this.db.exec("BEGIN");
    try {
      const insertMessage = this.db.prepare(
        "INSERT INTO messages (conversation_id, nonce, ciphertext) VALUES (?, ?, ?)",
      );
      const { lastInsertRowid } = insertMessage.run(
        conversationId,
        box.nonce,
        box.ciphertext,
      );
      const id = Number(lastInsertRowid);
      const insertToken = this.db.prepare(
        "INSERT OR IGNORE INTO tokens (message_id, token) VALUES (?, ?)",
      );
      for (const token of tokens) insertToken.run(id, token);
      this.db.exec("COMMIT");
      return id;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 使消息不可检索，但保留原始密文。 */
  recall(id: number): void {
    this.ensureOpen();
    this.db.prepare("UPDATE messages SET recalled = 1 WHERE id = ?").run(id);
  }

  /** 在指定会话中搜索未撤回消息，按 ID 倒序，支持 cursor 翻页。 */
  search(
    conversationIds: string[],
    query: string,
    limit: number,
    cursor?: number | null,
  ): SearchPage {
    this.ensureOpen();
    if (limit <= 0 || conversationIds.length === 0) {
      return { hits: [], cursor: null };
    }
    const normalizedQuery = normalizeForSearch(query);
    const queryToken =
      normalizedQuery.length > 0 ? deriveQueryToken(this.key, normalizedQuery) : null;

    const placeholders = conversationIds.map(() => "?").join(", ");
    const conditions = [
      `m.conversation_id IN (${placeholders})`,
      "m.recalled = 0",
    ];
    const params: (string | number | Uint8Array)[] = [...conversationIds];
    if (cursor !== undefined && cursor !== null) {
      conditions.push("m.id < ?");
      params.push(cursor);
    }
    if (queryToken !== null) {
      conditions.push(
        "EXISTS (SELECT 1 FROM tokens t WHERE t.message_id = m.id AND t.token = ?)",
      );
      params.push(queryToken);
    }
    const candidateStmt = this.db.prepare(
      `SELECT m.id FROM messages m WHERE ${conditions.join(" AND ")} ORDER BY m.id DESC`,
    );
    const candidateIds = (candidateStmt.all(...params) as { id: number }[]).map((r) =>
      Number(r.id),
    );

    const byId = this.db.prepare(
      "SELECT id, conversation_id, nonce, ciphertext, recalled FROM messages WHERE id = ?",
    );
    const hits: SearchHit[] = [];
    let stoppedEarly = false;
    for (const id of candidateIds) {
      if (hits.length >= limit) {
        stoppedEarly = true;
        break;
      }
      const row = byId.get(id) as unknown as MessageRow | undefined;
      if (row === undefined) continue;
      const text = open(this.key, {
        nonce: new Uint8Array(row.nonce),
        ciphertext: new Uint8Array(row.ciphertext),
      });
      if (!normalizeForSearch(text).includes(normalizedQuery)) continue;
      hits.push({ id: Number(row.id), conversationId: row.conversation_id, text });
    }
    return { hits, cursor: stoppedEarly ? hits[hits.length - 1].id : null };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
