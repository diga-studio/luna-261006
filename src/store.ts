import { DatabaseSync } from "node:sqlite";

/** SQLite 持久化层：消息密文 + 每消息一条标记序列 */
export interface StoredMessage {
  id: number;
  conversationId: string;
  ciphertext: Buffer;
  tokens: Buffer;
  recalled: boolean;
}

interface MessageRow {
  id: number;
  conversation_id: string;
  ciphertext: Buffer;
  tokens: Buffer;
  recalled: number;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        tokens BLOB NOT NULL,
        recalled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv
        ON messages (conversation_id, recalled, id);
    `);
  }

  /** 若库中已有校验值则比对，否则写入；返回密钥是否匹配 */
  initOrVerifyKeyCheck(check: Buffer): boolean {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = 'keyCheck'`)
      .get() as { value: Buffer } | undefined;
    if (row) {
      return Buffer.from(row.value).equals(check);
    }
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES ('keyCheck', ?)`)
      .run(check);
    return true;
  }

  insertMessage(conversationId: string, ciphertext: Buffer, tokens: Buffer): number {
    const result = this.db
      .prepare(
        `INSERT INTO messages (conversation_id, ciphertext, tokens) VALUES (?, ?, ?)`
      )
      .run(conversationId, ciphertext, tokens);
    return Number(result.lastInsertRowid);
  }

  markRecalled(id: number): void {
    this.db.prepare(`UPDATE messages SET recalled = 1 WHERE id = ?`).run(id);
  }

  /**
   * 按 id 倒序取一批指定会话、未撤回、id < beforeId 的记录。
   * 返回不足 batchSize 条表示已扫描到底。
   */
  candidates(conversationIds: string[], beforeId: number, batchSize: number): StoredMessage[] {
    const placeholders = conversationIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, ciphertext, tokens, recalled
         FROM messages
         WHERE recalled = 0 AND id < ? AND conversation_id IN (${placeholders})
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(beforeId, ...conversationIds, batchSize) as unknown as MessageRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      conversationId: row.conversation_id,
      ciphertext: Buffer.from(row.ciphertext),
      tokens: Buffer.from(row.tokens),
      recalled: row.recalled !== 0,
    }));
  }

  close(): void {
    this.db.close();
  }
}
