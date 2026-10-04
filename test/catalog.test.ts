import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ListingDedupIndex,
  validateThreshold,
  type ListingInput,
} from "../src/catalog.js";
import { toCodePoints, levenshtein } from "../src/levenshtein.js";

/** 独立的逐对精确参考实现：整数比较，不做四舍五入。 */
function bruteForce(
  catalog: ListingInput[],
  query: ListingInput,
  ta: number,
  td: number,
): string[] {
  const taS = Math.round(ta * 100);
  const tdS = Math.round(td * 100);
  const qa = toCodePoints(query.address);
  const qd = toCodePoints(query.description);
  const hits: string[] = [];
  for (const rec of catalog) {
    const ra = toCodePoints(rec.address);
    const rd = toCodePoints(rec.description);
    const maxA = Math.max(qa.length, ra.length);
    const maxD = Math.max(qd.length, rd.length);
    const edA = maxA === 0 ? 0 : levenshtein(qa, ra);
    const edD = maxD === 0 ? 0 : levenshtein(qd, rd);
    if (edA * 100 <= (100 - taS) * maxA && edD * 100 <= (100 - tdS) * maxD) {
      hits.push(rec.id);
    }
  }
  return hits;
}

function idsOf(index: ListingDedupIndex, q: ListingInput, ta: number, td: number): string[] {
  return index.findDuplicates(q, ta, td).map((c) => c.id);
}

test("阈值校验：合法值原样通过", () => {
  for (const t of [0.7, 0.71, 0.8, 0.85, 0.99, 1.0]) {
    assert.equal(validateThreshold(t, "t"), Math.round(t * 100));
  }
});

test("阈值校验：越界或超过两位小数抛 RangeError", () => {
  for (const t of [0.69, 0, 1.01, 2, 0.855, 0.701, 0.999, Number.NaN, Infinity, -0.7]) {
    assert.throws(() => validateThreshold(t, "t"), RangeError, `t=${t}`);
  }
});

test("阈值恰好相等算命中，多一次编辑则不命中", () => {
  // 地址 10 个码点，2 次编辑 -> 相似度恰为 0.80
  const base = "abcdefghij"; // 10 码点
  const twoEdits = "abXYefghij"; // 替换 2 个
  const threeEdits = "abXYefghZj"; // 替换 3 个 -> 0.70
  const desc = "完全相同的描述文本";
  const idx = new ListingDedupIndex([
    { id: "eq", address: twoEdits, description: desc },
    { id: "below", address: threeEdits, description: desc },
  ]);
  const hits = idsOf(idx, { id: "q", address: base, description: desc }, 0.8, 0.8);
  assert.deepEqual(hits, ["eq"]);
  assert.equal(base.length, 10);
});

test("一个字段达标另一个不达标则不返回", () => {
  const idx = new ListingDedupIndex([
    { id: "addrOnly", address: "北京市朝阳区建国路88号", description: "完全无关的描述内容甲乙丙丁" },
    { id: "descOnly", address: "广州市天河区体育西路1号", description: "南北通透两居室采光好" },
    { id: "both", address: "北京市朝阳区建国路88号", description: "南北通透两居室采光好" },
  ]);
  const hits = idsOf(
    idx,
    { id: "q", address: "北京市朝阳区建国路88号", description: "南北通透两居室采光好" },
    0.9,
    0.9,
  );
  assert.deepEqual(hits, ["both"]);
});

test("相同文本对应多个标识时分别保留", () => {
  const rec = { address: "上海市浦东新区世纪大道100号", description: "精装一居室，家电齐全。" };
  const idx = new ListingDedupIndex([
    { id: "x1", ...rec },
    { id: "x2", ...rec },
    { id: "x3", ...rec },
  ]);
  const hits = idx.findDuplicates({ id: "q", ...rec }, 1.0, 1.0);
  assert.deepEqual(hits.map((c) => c.id), ["x1", "x2", "x3"]);
  assert.ok(hits.every((c) => c.addressSimilarity === 1 && c.descriptionSimilarity === 1));
});

test("空串字段：空配空相似度为 1，空配非空为 0", () => {
  const idx = new ListingDedupIndex([
    { id: "empty", address: "", description: "" },
    { id: "nonempty", address: "某地址", description: "某描述" },
    { id: "halfEmpty", address: "", description: "某描述" },
  ]);
  const hits = idsOf(idx, { id: "q", address: "", description: "" }, 0.7, 0.7);
  assert.deepEqual(hits, ["empty"]);
});

test("非 BMP 字符参与目录匹配", () => {
  const idx = new ListingDedupIndex([
    { id: "emoji", address: "幸福小区😀栋101", description: "带花园🌳的三居室🏠" },
    { id: "other", address: "幸福小区😃栋102", description: "带花园🌲的三居室🏡" },
  ]);
  const hits = idsOf(
    idx,
    { id: "q", address: "幸福小区😀栋101", description: "带花园🌳的三居室🏠" },
    1.0,
    1.0,
  );
  assert.deepEqual(hits, ["emoji"]);
});

test("短串（短于 q-gram 长度）走退化路径仍正确", () => {
  const idx = new ListingDedupIndex([
    { id: "s1", address: "短", description: "甲乙" },
    { id: "s2", address: "长", description: "丙丁" },
  ]);
  assert.deepEqual(idsOf(idx, { id: "q", address: "短", description: "甲乙" }, 1.0, 1.0), ["s1"]);
  assert.deepEqual(idsOf(idx, { id: "q", address: "", description: "甲乙" }, 0.7, 1.0), []);
});

test("查询不修改目录，重复查询结果一致", () => {
  const cat: ListingInput[] = [
    { id: "r1", address: "北京市海淀区中关村大街27号", description: "一居室，近地铁。" },
    { id: "r2", address: "北京市海淀区中关村大街28号", description: "一居室，近地铁。" },
  ];
  const idx = new ListingDedupIndex(cat);
  const q = { id: "q", address: "北京市海淀区中关村大街27号", description: "一居室，近地铁。" };
  const first = idx.findDuplicates(q, 0.8, 0.8);
  const second = idx.findDuplicates(q, 0.8, 0.8);
  assert.deepEqual(first, second);
  assert.equal(idx.size, 2);
  assert.deepEqual(cat[0], { id: "r1", address: "北京市海淀区中关村大街27号", description: "一居室，近地铁。" });
});

// 可复现的伪随机数
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ALPHABET = ["a", "b", "c", "中", "文", "😀", " ", "1", "路", "号"];

function randomText(rnd: () => number, maxLen: number): string {
  const len = Math.floor(rnd() * (maxLen + 1));
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  return s;
}

function mutate(rnd: () => number, text: string): string {
  const chars = [...text];
  if (chars.length === 0) return randomText(rnd, 3);
  const op = rnd();
  const pos = Math.floor(rnd() * chars.length);
  const ch = ALPHABET[Math.floor(rnd() * ALPHABET.length)]!;
  if (op < 0.4) chars[pos] = ch; // 替换
  else if (op < 0.7) chars.splice(pos, 0, ch); // 插入
  else chars.splice(pos, 1); // 删除
  return chars.join("");
}

test("随机小目录：与逐对精确计算完全一致", () => {
  const rnd = makeRng(20261006);
  for (let round = 0; round < 30; round++) {
    const n = 1 + Math.floor(rnd() * 60);
    const catalog: ListingInput[] = [];
    for (let i = 0; i < n; i++) {
      catalog.push({
        id: `rec-${round}-${i}`,
        address: randomText(rnd, 20),
        description: randomText(rnd, 30),
      });
    }
    // 制造一些近似重复与完全重复
    for (let i = 0; i < 10 && catalog.length > 1; i++) {
      const src = catalog[Math.floor(rnd() * catalog.length)]!;
      const copy: ListingInput = {
        id: `dup-${round}-${i}`,
        address: rnd() < 0.5 ? src.address : mutate(rnd, src.address),
        description: rnd() < 0.5 ? src.description : mutate(rnd, src.description),
      };
      catalog.push(copy);
    }
    const idx = new ListingDedupIndex(catalog);
    for (let qi = 0; qi < 15; qi++) {
      const query: ListingInput = {
        id: "query",
        address: rnd() < 0.5 ? randomText(rnd, 20) : mutate(rnd, catalog[Math.floor(rnd() * catalog.length)]!.address),
        description: rnd() < 0.5 ? randomText(rnd, 30) : mutate(rnd, catalog[Math.floor(rnd() * catalog.length)]!.description),
      };
      const ta = [0.7, 0.75, 0.8, 0.9, 0.95, 1.0][Math.floor(rnd() * 6)]!;
      const td = [0.7, 0.75, 0.8, 0.9, 0.95, 1.0][Math.floor(rnd() * 6)]!;
      const expected = bruteForce(catalog, query, ta, td);
      const actual = idx.findDuplicates(query, ta, td);
      assert.deepEqual(
        actual.map((c) => c.id),
        expected,
        `round=${round} qi=${qi} ta=${ta} td=${td} q=${JSON.stringify(query)}`,
      );
      // 相似度数值与精确计算一致
      for (const c of actual) {
        const rec = catalog.find((r) => r.id === c.id)!;
        const ra = toCodePoints(rec.address);
        const rd = toCodePoints(rec.description);
        const qa = toCodePoints(query.address);
        const qd = toCodePoints(query.description);
        const maxA = Math.max(qa.length, ra.length);
        const maxD = Math.max(qd.length, rd.length);
        const expA = maxA === 0 ? 1 : 1 - levenshtein(qa, ra) / maxA;
        const expD = maxD === 0 ? 1 : 1 - levenshtein(qd, rd) / maxD;
        assert.ok(Math.abs(c.addressSimilarity - expA) < 1e-12);
        assert.ok(Math.abs(c.descriptionSimilarity - expD) < 1e-12);
      }
    }
  }
});
