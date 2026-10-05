import { VaultChat, SearchHit, normalizeForSearch } from "../src/index.js";

export interface RecordedMessage {
  id: number;
  conversationId: string;
  text: string;
  recalled: boolean;
}

/**
 * 独立的明文遍历基准实现：
 * 在全部可见正文上按固定定义（NFC -> toLowerCase -> NFC，连续子串）求结果。
 */
export function baselineSearch(
  messages: RecordedMessage[],
  conversationIds: string[],
  query: string,
): { id: number; conversationId: string; text: string }[] {
  const normalizedQuery = normalizeForSearch(query);
  return messages
    .filter(
      (m) =>
        !m.recalled &&
        conversationIds.includes(m.conversationId) &&
        normalizeForSearch(m.text).includes(normalizedQuery),
    )
    .map((m) => ({ id: m.id, conversationId: m.conversationId, text: m.text }))
    .sort((a, b) => b.id - a.id);
}

/** 用指定页大小通过 cursor 翻页收集全部结果。 */
export function collectAllPages(
  vc: VaultChat,
  conversationIds: string[],
  query: string,
  pageSize: number,
): SearchHit[] {
  const all: SearchHit[] = [];
  let cursor: number | null = null;
  for (let guard = 0; guard < 100000; guard++) {
    const page = vc.search(conversationIds, query, pageSize, cursor);
    all.push(...page.hits);
    if (page.cursor === null) return all;
    cursor = page.cursor;
  }
  throw new Error("pagination did not terminate");
}

/** 校验分页结果与基准完全一致：顺序、重复次数、内容。 */
export function assertSameHits(
  actual: SearchHit[],
  expected: { id: number; conversationId: string; text: string }[],
): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `hit count mismatch: actual ${actual.length}, expected ${expected.length}\n` +
        `actual ids: [${actual.map((h) => h.id).join(",")}]\n` +
        `expected ids: [${expected.map((h) => h.id).join(",")}]`,
    );
  }
  for (let i = 0; i < actual.length; i++) {
    if (
      actual[i].id !== expected[i].id ||
      actual[i].conversationId !== expected[i].conversationId ||
      actual[i].text !== expected[i].text
    ) {
      throw new Error(
        `hit ${i} mismatch:\nactual:   ${JSON.stringify(actual[i])}\nexpected: ${JSON.stringify(expected[i])}`,
      );
    }
  }
  for (let i = 1; i < actual.length; i++) {
    if (actual[i - 1].id <= actual[i].id) {
      throw new Error(`hits not in descending id order at ${i}`);
    }
  }
}
