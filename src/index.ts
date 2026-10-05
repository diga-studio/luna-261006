import { MessageCipher } from "./crypto.js";
import { normalizeText } from "./normalize.js";
import { Store } from "./store.js";

export interface SearchHit {
  id: number;
  conversationId: string;
  text: string;
}

export interface SearchPage {
  /** 匹配消息，按 id 倒序 */
  messages: SearchHit[];
  /** 传给下一次 search 的游标；null 表示没有更多结果 */
  cursor: number | null;
}

const MAX_SQLITE_ID = 9223372036854775807;
const BATCH_SIZE = 256;

export class VaultChat {
  private constructor(
    private readonly store: Store,
    private readonly cipher: MessageCipher
  ) {}

  /** 打开（或创建）数据库；key 必须为 32 字节，且须与创建时一致 */
  static open(path: string, key: Uint8Array): VaultChat {
    const cipher = new MessageCipher(key);
    const store = new Store(path);
    if (!store.initOrVerifyKeyCheck(cipher.keyCheckValue())) {
      store.close();
      throw new Error("key does not match the database");
    }
    return new VaultChat(store, cipher);
  }

  /** 写入一条消息，返回全库递增的消息 ID */
  append(conversationId: string, text: string): number {
    const ciphertext = this.cipher.encrypt(text);
    const tokens = this.cipher.tokensForString(normalizeText(text));
    return this.store.insertMessage(conversationId, ciphertext, tokens);
  }

  /** 撤回：消息不再可检索，但保留原始密文 */
  recall(id: number): void {
    this.store.markRecalled(id);
  }

  /**
   * 在指定会话的未撤回消息中搜索规范化后的连续子串，
   * 按 id 倒序返回至多 limit 条；cursor 为上一页最后一条的 id。
   */
  search(
    conversationIds: string[],
    query: string,
    limit: number,
    cursor: number | null = null
  ): SearchPage {
    if (conversationIds.length === 0 || limit <= 0) {
      return { messages: [], cursor: null };
    }
    const needle = this.cipher.tokensForString(normalizeText(query));
    const hits: SearchHit[] = [];
    let beforeId = cursor ?? MAX_SQLITE_ID;

    scan: while (hits.length < limit) {
      const batch = this.store.candidates(conversationIds, beforeId, BATCH_SIZE);
      if (batch.length === 0) {
        break;
      }
      for (const row of batch) {
        beforeId = row.id;
        if (needle.length === 0 || row.tokens.indexOf(needle) !== -1) {
          hits.push({
            id: row.id,
            conversationId: row.conversationId,
            text: this.cipher.decrypt(row.ciphertext),
          });
          if (hits.length === limit) {
            break scan;
          }
        }
      }
      if (batch.length < BATCH_SIZE) {
        break;
      }
    }

    // 未集满 limit 条说明已扫描到底，没有更多结果
    return {
      messages: hits,
      cursor: hits.length === limit ? beforeId : null,
    };
  }

  close(): void {
    this.store.close();
  }
}
