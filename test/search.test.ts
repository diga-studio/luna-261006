import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { VaultChat } from "../src/index.js";
import {
  RecordedMessage,
  assertSameHits,
  baselineSearch,
  collectAllPages,
} from "./helpers.js";

let dir: string;
let vc: VaultChat;
const messages: RecordedMessage[] = [];

const CONVS = ["conv-a", "conv-b", "conv-c"];

// 长查询：大量重复字符
const QUERY_REPEAT = "a".repeat(40) + "b";
// 组合字符（分解形式 é = e + U+0301）、中文、非 BMP 字符混合
const QUERY_MIXED = "é好𠮷👍";
// 含空格与标点
const QUERY_PUNCT = "hello,  world !";

function add(conversationId: string, text: string): void {
  const id = vc.append(conversationId, text);
  messages.push({ id, conversationId, text, recalled: false });
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "vaultchat-search-"));
  vc = new VaultChat({ path: join(dir, "test.db"), key: randomBytes(32) });

  // --- 针对 QUERY_REPEAT 的诱饵与命中 ---
  // 诱饵：包含查询的长片段，但永远凑不出完整查询
  for (let i = 0; i < 120; i++) {
    const conv = CONVS[i % CONVS.length];
    add(conv, "a".repeat(39) + "b"); // 差一个 a
    add(conv, "a".repeat(60)); // 有 40 个 a 但后面没有 b
    add(conv, "b" + "a".repeat(40)); // b 在 a 前面
    add(conv, "a".repeat(20 + (i % 19)) + "x" + "a".repeat(40) + "c"); // 尾字符不对
  }
  // 命中：位置、前后缀、重复出现次数各不相同
  add("conv-a", QUERY_REPEAT);
  add("conv-a", "prefix-" + QUERY_REPEAT + "-suffix");
  add("conv-b", "a".repeat(100) + "b"); // 内部偏移 61 处命中
  add("conv-b", QUERY_REPEAT + QUERY_REPEAT); // 同一正文出现两次，仍只算一条消息
  add("conv-c", "a".repeat(41) + "b"); // 41 个 a + b，偏移 1 处命中
  add("conv-c", "a".repeat(41) + "b");
  add("conv-c", "a".repeat(41) + "b"); // 三条完全相同的正文，验证重复计数

  // --- 针对 QUERY_MIXED 的诱饵与命中 ---
  const composed = "é好𠮷👍"; // 预组合形式，规范化后应与分解形式查询相等
  for (let i = 0; i < 90; i++) {
    const conv = CONVS[i % CONVS.length];
    add(conv, "é好𠮷"); // 缺 emoji
    add(conv, "é好👍"); // 缺非 BMP 字
    add(conv, "好𠮷👍"); // 缺 é
    add(conv, "é好𠮷�👍"); // 中间多字符
    add(conv, "é好𠮷"); // 跨消息边界：本消息只有前缀
    add(conv, "👍 extra"); // 另一条只有后缀，不能跨消息匹配
  }
  add("conv-a", composed);
  add("conv-b", "É好𠮷👍"); // 大写 É，toLowerCase 后应命中
  add("conv-b", "前置" + composed + "后置");
  add("conv-c", "é好𠮷👍"); // 分解形式存储，同样应命中
  add("conv-c", "éé好𠮷👍"); // 边界：前一个 é 后紧跟命中串

  // --- 针对 QUERY_PUNCT 的诱饵与命中 ---
  for (let i = 0; i < 60; i++) {
    const conv = CONVS[i % CONVS.length];
    add(conv, "hello, world !"); // 单空格
    add(conv, "hello,  world !".slice(0, -1)); // 差末尾字符
    add(conv, "hello,  world  !"); // 多空格
  }
  add("conv-a", QUERY_PUNCT);
  add("conv-b", "say " + QUERY_PUNCT + " now");
  add("conv-c", "HELLO,  WORLD !"); // 大小写不同，规范化后命中

  // --- 与任何查询都无关的噪声 ---
  for (let i = 0; i < 80; i++) {
    add(CONVS[i % CONVS.length], `noise message ${i} 随机噪声🎈`);
  }
});

after(() => {
  vc.close();
  rmSync(dir, { recursive: true, force: true });
});

const scopes: [string[], string][] = [
  [CONVS, "all conversations"],
  [["conv-a"], "single conversation"],
  [["conv-b", "conv-c"], "subset"],
];
const pageSizes = [1, 2, 5, 1000];
const queries: [string, string][] = [
  [QUERY_REPEAT, "long repeated-char query"],
  [QUERY_MIXED, "combining+CJK+non-BMP query"],
  [QUERY_PUNCT, "spaces/punctuation query"],
  ["不存在的查询串🚫", "no-hit query"],
];

for (const [query, qname] of queries) {
  for (const [scope, sname] of scopes) {
    for (const pageSize of pageSizes) {
      test(`${qname} / ${sname} / pageSize=${pageSize}`, () => {
        const expected = baselineSearch(messages, scope, query);
        const actual = collectAllPages(vc, scope, query, pageSize);
        assertSameHits(actual, expected);
      });
    }
  }
}

test("append returns globally increasing ids", () => {
  const ids = messages.map((m) => m.id);
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i] > ids[i - 1], `id ${ids[i]} not greater than ${ids[i - 1]}`);
  }
});

test("empty query matches every visible message", () => {
  const expected = baselineSearch(messages, CONVS, "");
  const actual = collectAllPages(vc, CONVS, "", 7);
  assertSameHits(actual, expected);
});

test("empty conversation list yields no hits", () => {
  const page = vc.search([], QUERY_REPEAT, 10);
  assert.equal(page.hits.length, 0);
  assert.equal(page.cursor, null);
});
