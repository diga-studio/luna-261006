import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { VaultChat, SearchPage } from "../src/index.js";

/** 独立的规范化基准实现（规范定义：NFC -> toLowerCase -> NFC） */
function baselineNormalize(text: string): string {
  return text.normalize("NFC").toLowerCase().normalize("NFC");
}

interface PlainMessage {
  id: number;
  conversationId: string;
  text: string;
  recalled: boolean;
}

/** 独立的明文遍历基准：在全部可见正文上按定义求匹配，按 id 倒序 */
function baselineSearchAll(
  all: PlainMessage[],
  conversationIds: string[],
  query: string
): PlainMessage[] {
  const nq = baselineNormalize(query);
  return all
    .filter(
      (m) =>
        !m.recalled &&
        conversationIds.includes(m.conversationId) &&
        baselineNormalize(m.text).includes(nq)
    )
    .sort((a, b) => b.id - a.id);
}

/** 收集被测库的全部分页结果 */
function collectAllPages(
  vault: VaultChat,
  conversationIds: string[],
  query: string,
  limit: number
): { ids: number[]; texts: string[]; pageSizes: number[] } {
  const ids: number[] = [];
  const texts: string[] = [];
  const pageSizes: number[] = [];
  let cursor: number | null = null;
  for (;;) {
    const page: SearchPage = vault.search(conversationIds, query, limit, cursor);
    pageSizes.push(page.messages.length);
    for (const m of page.messages) {
      ids.push(m.id);
      texts.push(m.text);
    }
    if (page.cursor === null) break;
    cursor = page.cursor;
    assert.ok(page.messages.length > 0, "非末尾页不得为空");
  }
  return { ids, texts, pageSizes };
}

function compareWithBaseline(
  vault: VaultChat,
  all: PlainMessage[],
  conversationIds: string[],
  query: string,
  limit: number
): void {
  const expected = baselineSearchAll(all, conversationIds, query);
  const got = collectAllPages(vault, conversationIds, query, limit);
  assert.deepEqual(
    got.ids,
    expected.map((m) => m.id),
    `查询 ${JSON.stringify(query)} 的 id 序列（顺序/重复/边界）不一致`
  );
  assert.deepEqual(
    got.texts,
    expected.map((m) => m.text),
    `查询 ${JSON.stringify(query)} 的正文序列不一致`
  );
  // 分页大小：除最后一页外每页必须恰好 limit 条
  for (let i = 0; i < got.pageSizes.length - 1; i++) {
    assert.equal(got.pageSizes[i], limit, "中间页必须填满");
  }
  assert.equal(got.pageSizes.reduce((a, b) => a + b, 0), expected.length);
}

/** 可复现的伪随机数 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARKER = "Zq9PLAINTEXTMARKER7w";

test("对抗性语料：近失片段 + 长重复查询 + 组合字符/中文/非BMP 混合查询", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaultchat-test1-"));
  try {
    const key = randomBytes(32);
    const vault = VaultChat.open(join(dir, "chat.db"), key);
    const all: PlainMessage[] = [];
    const rand = mulberry32(42);
    const convs = ["conv-a", "conv-b", "conv-c"];
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

    const append = (conversationId: string, text: string) => {
      const id = vault.append(conversationId, text);
      all.push({ id, conversationId, text, recalled: false });
    };

    // ---- 针对 Q1 = "a"*40+"b" 的近失与命中 ----
    const q1 = "a".repeat(40) + "b";
    for (let k = 0; k < 40; k++) {
      // 近失：相同短片段（长 a 串）但缺结尾 b 或 a 不够
      append(pick(convs), `${MARKER}x${"a".repeat(k)}`);
      append(pick(convs), `${MARKER}y${"a".repeat(k)}c${"a".repeat(39 - k)}`);
    }
    for (let k = 0; k < 39; k++) {
      append(pick(convs), `${MARKER}z${"a".repeat(k)}b`); // a 不足 40 个
    }
    for (let i = 0; i < 25; i++) {
      // 命中：a 串 >= 40 后接 b；有的前后带噪声、有的多次出现
      const extra = Math.floor(rand() * 5);
      append(
        pick(convs),
        `${MARKER}h${"a".repeat(40 + extra)}b${i % 3 === 0 ? "noise" + q1 : ""}`
      );
    }

    // ---- 针对 Q2（组合字符 + 中文 + 非BMP）的近失与命中 ----
    const q2 = "e\u0301中文😀𝕏"; // e + 组合尖音符 + 中文 + 非BMP
    const q2Misses = [
      "e\u0301中文😀", // 缺 𝕏
      "e\u0301中😀𝕏", // 缺 文
      "é 中文😀𝕏", // 多空格
      "é中文😀", // 预组合但缺 𝕏
      "e\u0301中文😀𝕏".slice(1), // 缺首字符
      "f\u0301中文😀𝕏", // 首字符不同
      "é中文😀𝕏𝕏".slice(0, 5), // 截断
      "é中文😀𝕏 ".slice(0, 4), // 截断到 😀 之前
      "É 中文😀𝕏", // 大写但带空格
      "e\u0301中文😀\uD835", // 𝕏 只剩半个代理对
    ];
    for (let i = 0; i < 30; i++) {
      for (const m of q2Misses) {
        append(pick(convs), `${MARKER}m${i}${m}tail`);
      }
    }
    const q2Hits = [
      "é中文😀𝕏", // 预组合 é（NFC 后相同）
      "e\u0301中文😀𝕏", // 与查询逐码元相同
      "É中文😀𝕏", // 大写 É（toLowerCase 后相同）
      "E\u0301中文😀𝕏", // 大写 E + 组合符
      "é中文😀𝕩", // 已小写的 𝕩
      "É中文😀𝕏é中文😀𝕏", // 重复出现两次
      "prefixé中文😀𝕏suffix",
      "😀é中文😀𝕏😀",
    ];
    for (const h of q2Hits) {
      append(pick(convs), `${MARKER}H${h}`);
    }

    // ---- 针对 Q3（非BMP 边界 + 重复）的近失与命中 ----
    const q3 = "😀😀😀x";
    for (let i = 0; i < 20; i++) {
      append(pick(convs), `${MARKER}p😀😀x`); // 少一个 😀
      append(pick(convs), `${MARKER}p😀😀😀`); // 缺 x
      append(pick(convs), `${MARKER}p😀😀😀😀y`); // 中间断开
    }
    for (let i = 0; i < 8; i++) {
      append(pick(convs), `${MARKER}P😀😀😀x`);
      append(pick(convs), `${MARKER}P😀😀😀😀x`); // 包含 😀😀😀x（从第二个 😀 起）
    }

    // ---- 随机噪声消息，稀释语料 ----
    const alphabet = ["a","b","é","中","\u0301","文","😀","𝕏","x","y","z"," ","、", "。","!"];
    for (let i = 0; i < 1500; i++) {
      let s = MARKER + "n";
      const len = 5 + Math.floor(rand() * 40);
      for (let j = 0; j < len; j++) {
        s += alphabet[Math.floor(rand() * alphabet.length)];
      }
      append(pick(convs), s);
    }

    // ---- 全量分页对比（多种页大小、多种会话范围） ----
    for (const query of [q1, q2, q3, "é", "😀", "𝕏", "中文", MARKER]) {
      for (const limit of [1, 3, 7, 64]) {
        for (const scope of [convs, [convs[0]], [convs[1], convs[2]]]) {
          compareWithBaseline(vault, all, scope, query, limit);
        }
      }
    }

    vault.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("关闭重开 + 撤回 + 会话范围分页 + 落盘无明文", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaultchat-test2-"));
  try {
    const dbPath = join(dir, "chat.db");
    const key = randomBytes(32);
    const all: PlainMessage[] = [];

    const secret1 = `${MARKER}-alpha-秘密正文`;
    const secret2 = `${MARKER}-beta-😀𝕏-secret`;
    const secret3 = `${MARKER}-gamma-e\u0301-组合`;

    {
      const vault = VaultChat.open(dbPath, key);
      for (let i = 0; i < 60; i++) {
        const conv = i % 2 === 0 ? "room-1" : "room-2";
        const text =
          i % 5 === 0
            ? `${secret1} 命中${i}`
            : i % 5 === 1
              ? `${secret2} hit${i}`
              : i % 5 === 2
                ? `${secret3} 命中${i}`
                : `普通消息${i} 不含目标`;
        const id = vault.append(conv, text);
        all.push({ id, conversationId: conv, text, recalled: false });
      }
      vault.close();
    }

    // 同一密钥重新打开
    const vault = VaultChat.open(dbPath, key);

    // 错误密钥应被拒绝
    assert.throws(() => VaultChat.open(dbPath, randomBytes(32)), /key/);

    // 撤回部分命中消息
    const recalledIds = new Set<number>();
    for (const m of all) {
      if (m.text.includes("命中") && m.id % 3 === 0) {
        vault.recall(m.id);
        m.recalled = true;
        recalledIds.add(m.id);
      }
    }

    // 不同会话范围 + 不同页大小分页，与基准对比
    for (const query of ["命中", "hit", "秘密正文", `${MARKER}`]) {
      for (const limit of [2, 5, 100]) {
        for (const scope of [["room-1"], ["room-2"], ["room-1", "room-2"]]) {
          compareWithBaseline(vault, all, scope, query, limit);
        }
      }
    }

    // 已撤回消息绝不出现在结果中
    const page = collectAllPages(vault, ["room-1", "room-2"], "命中", 4);
    for (const id of page.ids) {
      assert.ok(!recalledIds.has(id), `消息 ${id} 已撤回却被返回`);
    }

    vault.close();

    // 数据库及伴随文件中不得出现明文片段
    const fragments = [secret1, secret2, secret3, "命中", "秘密正文", "普通消息"];
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const file = dbPath + suffix;
      if (!existsSync(file)) continue;
      const content = readFileSync(file);
      for (const frag of fragments) {
        assert.equal(
          content.indexOf(Buffer.from(frag, "utf8")),
          -1,
          `${file} 中不应出现明文片段 ${JSON.stringify(frag)}`
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
