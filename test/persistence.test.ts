import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { VaultChat, normalizeForSearch } from "../src/index.js";
import {
  RecordedMessage,
  assertSameHits,
  baselineSearch,
  collectAllPages,
} from "./helpers.js";

const MARK = "MARKER-9f3q7z";
const QUERY = `${MARK} 机密 payload`;

const dir = mkdtempSync(join(tmpdir(), "vaultchat-persist-"));
const dbPath = join(dir, "vault.db");
const key = randomBytes(32);
const messages: RecordedMessage[] = [];

function appendAll(vc: VaultChat, entries: [string, string][]): void {
  for (const [conversationId, text] of entries) {
    const id = vc.append(conversationId, text);
    messages.push({ id, conversationId, text, recalled: false });
  }
}

test("write, close, reopen, recall, paginate across scopes", () => {
  // 第一次会话：写入并关闭
  const first = new VaultChat({ path: dbPath, key });
  appendAll(first, [
    ["alpha", `${QUERY} #1`],
    ["alpha", `无关正文 without marker`],
    ["beta", `前缀${QUERY}后缀 #2`],
    ["beta", `${QUERY} #3`],
    ["gamma", `${QUERY} #4`],
  ]);
  const lastIdFirstSession = messages[messages.length - 1].id;
  first.close();

  // 同一密钥重新打开，ID 继续递增
  const second = new VaultChat({ path: dbPath, key });
  appendAll(second, [
    ["alpha", `${QUERY} #5`],
    ["beta", `另一段 ${MARK} 但只有短片段`],
    ["gamma", `é${QUERY} #6 组合字符́`],
  ]);
  assert.ok(
    messages[messages.length - 1].id > lastIdFirstSession,
    "ids must keep increasing after reopen",
  );

  // 撤回部分命中消息
  const toRecall = [messages[0].id, messages[2].id, messages[5].id];
  for (const id of toRecall) {
    second.recall(id);
    messages.find((m) => m.id === id)!.recalled = true;
  }

  // 撤回后密文仍然保留
  const raw = new DatabaseSync(dbPath);
  const row = raw
    .prepare("SELECT ciphertext FROM messages WHERE id = ?")
    .get(toRecall[0]) as { ciphertext: Uint8Array };
  assert.ok(row.ciphertext.length > 0, "recalled message must keep its ciphertext");
  raw.close();

  // 不同会话范围 + 不同页大小，对照基准
  const scopes: string[][] = [
    ["alpha", "beta", "gamma"],
    ["alpha"],
    ["beta", "gamma"],
    ["gamma"],
  ];
  for (const scope of scopes) {
    for (const pageSize of [1, 2, 100]) {
      const expected = baselineSearch(messages, scope, QUERY);
      const actual = collectAllPages(second, scope, QUERY, pageSize);
      assertSameHits(actual, expected);
      for (const id of toRecall) {
        assert.ok(
          !actual.some((h) => h.id === id),
          `recalled message ${id} must not be returned`,
        );
      }
    }
  }
  second.close();

  // 错误密钥无法打开
  assert.throws(
    () => new VaultChat({ path: dbPath, key: randomBytes(32) }),
    /key does not match/,
  );

  // 数据库及伴随文件中不得出现明文正文、规范化正文或明文查询
  const forbidden = new Set<string>();
  for (const m of messages) {
    forbidden.add(m.text);
    forbidden.add(normalizeForSearch(m.text));
    forbidden.add(MARK); // 正文中的标志性片段
  }
  forbidden.add(QUERY);
  forbidden.add(normalizeForSearch(QUERY));
  for (const file of readdirSync(dir)) {
    const content = readFileSync(join(dir, file));
    for (const s of forbidden) {
      const needle = Buffer.from(s, "utf8");
      assert.equal(
        content.indexOf(needle),
        -1,
        `plaintext fragment ${JSON.stringify(s)} found in ${file}`,
      );
    }
  }

  rmSync(dir, { recursive: true, force: true });
});
