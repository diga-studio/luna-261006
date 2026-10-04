import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog, assertValidThreshold } from "../src/catalog.js";
import { levenshteinDistance, codePoints } from "../src/levenshtein.js";
import type { ListingRecord } from "../src/types.js";

/** 独立参考实现：逐对精确计算编辑距离，用整数有理数比较判定阈值。 */
function bruteForce(
  records: readonly ListingRecord[],
  query: ListingRecord,
  addrT: number,
  descT: number,
): string[] {
  const addrTP = Math.round(addrT * 100);
  const descTP = Math.round(descT * 100);
  const hits: string[] = [];
  for (const rec of records) {
    if (
      fieldMatch(query.address, rec.address, addrTP) &&
      fieldMatch(query.description, rec.description, descTP)
    ) {
      hits.push(rec.id);
    }
  }
  return hits;
}

function fieldMatch(a: string, b: string, tPercent: number): boolean {
  const m = Math.max(codePoints(a).length, codePoints(b).length);
  if (m === 0) return true; // 两侧均为空串，相似度为 1
  const d = levenshteinDistance(a, b);
  return (m - d) * 100 >= tPercent * m;
}

function rec(id: string, address: string, description: string): ListingRecord {
  return { id, address, description };
}

test("空串与短串", () => {
  const catalog = loadCatalog([
    rec("empty-both", "", ""),
    rec("empty-addr", "", "有描述"),
    rec("short", "ab", "xy"),
    rec("one", "a", "x"),
  ]);
  // 查询两侧皆空：只有完全为空的记录两字段都达标
  assert.deepEqual(
    catalog.findDuplicates(rec("q", "", ""), 0.7, 0.7),
    ["empty-both"],
  );
  // 空地址 vs 空地址相似度 1；空描述 vs 非空描述相似度 0
  assert.deepEqual(
    catalog.findDuplicates(rec("q", "", "有描述"), 1.0, 1.0),
    ["empty-addr"],
  );
  // 极短串（短于 q-gram 长度）走回退路径也要正确
  assert.deepEqual(
    catalog.findDuplicates(rec("q", "ab", "xy"), 1.0, 1.0),
    ["short"],
  );
  assert.deepEqual(
    catalog.findDuplicates(rec("q", "a", "x"), 0.7, 0.7),
    ["one"],
  );
});

test("非 BMP 字符按码点计长", () => {
  // "🙂" 是 1 个码点（2 个 UTF-16 单元）
  const catalog = loadCatalog([
    rec("emoji-same", "🙂🙂🙂路", "描述👍👍"),
    rec("emoji-diff", "🙂🙂🙃路", "描述👍👍"),
  ]);
  // 与 🙂🙂🙂路 距离 0；与 🙂🙂🙃路 距离 1，M=4，相似度 0.75
  assert.deepEqual(
    catalog.findDuplicates(rec("q", "🙂🙂🙂路", "描述👍👍"), 0.8, 0.8),
    ["emoji-same"],
  );
  assert.deepEqual(
    catalog.findDuplicates(rec("q", "🙂🙂🙂路", "描述👍👍"), 0.75, 0.75),
    ["emoji-same", "emoji-diff"],
  );
  // 组合字符（👨‍👩‍👧‍👦 为多个码点）按码点而非字素处理
  const fam = "👨‍👩‍👧‍👦";
  assert.equal(codePoints(fam).length, 7);
  const c2 = loadCatalog([rec("fam", fam + "小区", "x")]);
  assert.deepEqual(
    c2.findDuplicates(rec("q", fam + "小区", "x"), 1.0, 1.0),
    ["fam"],
  );
});

test("阈值恰好相等与相差一次编辑", () => {
  // 地址 4 码点，差 1 次替换：相似度 0.75；描述完全相同
  const catalog = loadCatalog([rec("r1", "abcd", "相同描述文本")]);
  const q = rec("q", "abce", "相同描述文本");
  assert.deepEqual(catalog.findDuplicates(q, 0.75, 1.0), ["r1"]); // 恰好相等算命中
  assert.deepEqual(catalog.findDuplicates(q, 0.76, 1.0), []); // 略高则不中
  // 再构造一个差 2 次编辑的：相似度 0.5，永远到不了 0.70
  const c2 = loadCatalog([rec("r2", "abxx", "相同描述文本")]);
  assert.deepEqual(c2.findDuplicates(q, 0.7, 1.0), []);
});

test("一个字段达标另一个未达标则不返回", () => {
  const catalog = loadCatalog([
    rec("addr-only", "北京市朝阳区建国路1号", "完全不同的描述内容"),
    rec("desc-only", "上海市静安区南京西路100号", "精装修拎包入住"),
    rec("both", "北京市朝阳区建国路1号", "精装修拎包入住"),
  ]);
  const q = rec("q", "北京市朝阳区建国路1号", "精装修拎包入住");
  assert.deepEqual(catalog.findDuplicates(q, 1.0, 1.0), ["both"]);
});

test("相同文本对应多个标识分别保留", () => {
  const catalog = loadCatalog([
    rec("id-a", "同一地址", "同一描述"),
    rec("id-b", "同一地址", "同一描述"),
    rec("id-c", "同一地址", "同一描述"),
  ]);
  assert.deepEqual(
    catalog.findDuplicates(rec("q", "同一地址", "同一描述"), 1.0, 1.0),
    ["id-a", "id-b", "id-c"],
  );
});

test("阈值校验", () => {
  const catalog = loadCatalog([rec("a", "x", "y")]);
  const q = rec("q", "x", "y");
  for (const bad of [0.69, 1.01, 0.699, 1.001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => catalog.findDuplicates(q, bad, 0.8), RangeError);
    assert.throws(() => catalog.findDuplicates(q, 0.8, bad), RangeError);
  }
  assert.throws(() => catalog.findDuplicates(q, 0.755, 0.8), RangeError); // 超过两位小数
  assert.throws(() => assertValidThreshold(0.5, "t"), RangeError);
  assertValidThreshold(0.7, "t");
  assertValidThreshold(1.0, "t");
  assertValidThreshold(0.85, "t");
  // 合法边界可正常查询
  assert.deepEqual(catalog.findDuplicates(q, 0.7, 0.7), ["a"]);
  assert.deepEqual(catalog.findDuplicates(q, 1.0, 1.0), ["a"]);
});

test("随机小目录与逐对精确计算完全一致", () => {
  let state = 20261004;
  const rnd = () => (state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const alpha = ["a", "b", "c", "你", "好", "路", "🙂", "👍", "é"];
  const randText = (maxLen: number) => {
    const n = Math.floor(rnd() * (maxLen + 1));
    let s = "";
    for (let i = 0; i < n; i++) s += pick(alpha);
    return s;
  };
  const mutate = (s: string) => {
    const cps = codePoints(s);
    if (cps.length === 0) return s + pick(alpha);
    const op = rnd();
    const i = Math.floor(rnd() * cps.length);
    if (op < 0.4) cps[i] = pick(alpha); // 替换
    else if (op < 0.7) cps.splice(i, 1); // 删除
    else cps.splice(i, 0, pick(alpha)); // 插入
    return cps.join("");
  };

  for (let round = 0; round < 30; round++) {
    const records: ListingRecord[] = [];
    const base = 1 + Math.floor(rnd() * 12);
    for (let i = 0; i < base; i++) {
      records.push(rec(`r${i}`, randText(10), randText(14)));
    }
    // 加入若干近重复，保证有命中
    const extra = Math.floor(rnd() * 6);
    for (let i = 0; i < extra && records.length > 0; i++) {
      const src = pick(records);
      records.push(
        rec(`dup${i}`, mutate(mutate(src.address)), mutate(src.description)),
      );
    }
    const catalog = loadCatalog(records);
    for (let qi = 0; qi < 20; qi++) {
      const q = rec("q", randText(10), randText(14));
      const addrT = pick([0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0]);
      const descT = pick([0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0]);
      const got = catalog.findDuplicates(q, addrT, descT);
      const want = bruteForce(records, q, addrT, descT);
      assert.deepEqual(
        got,
        want,
        `round=${round} qi=${qi} q=${JSON.stringify(q)} t=${addrT}/${descT}`,
      );
    }
  }
});

test("中长文本随机目录与逐对精确计算一致", () => {
  let state = 998877;
  const rnd = () => (state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const addrChars = "北京市朝阳区建国路街道号院小区栋单元室123456789";
  const descChars = "精装修南北通透采光好拎包入住满五唯一学区房地铁口";
  const randText = (chars: string, len: number) => {
    let s = "";
    for (let i = 0; i < len; i++) s += chars[Math.floor(rnd() * chars.length)];
    return s;
  };
  const mutate = (s: string, times: number) => {
    let cps = codePoints(s);
    for (let t = 0; t < times; t++) {
      const chars = cps.length > 40 ? descChars : addrChars;
      const op = rnd();
      const i = Math.floor(rnd() * cps.length);
      if (op < 0.4) cps[i] = chars[Math.floor(rnd() * chars.length)]!;
      else if (op < 0.7 && cps.length > 1) cps.splice(i, 1);
      else cps.splice(i, 0, chars[Math.floor(rnd() * chars.length)]!);
    }
    return cps.join("");
  };

  for (let round = 0; round < 8; round++) {
    const records: ListingRecord[] = [];
    for (let i = 0; i < 60; i++) {
      records.push(
        rec(`r${i}`, randText(addrChars, 40 + Math.floor(rnd() * 20)), randText(descChars, 160 + Math.floor(rnd() * 40))),
      );
    }
    // 近重复：编辑 1~12 次，覆盖阈值上下两侧
    for (let i = 0; i < 30; i++) {
      const src = records[Math.floor(rnd() * records.length)]!;
      records.push(
        rec(`dup${i}`, mutate(src.address, 1 + Math.floor(rnd() * 12)), mutate(src.description, 1 + Math.floor(rnd() * 12))),
      );
    }
    const catalog = loadCatalog(records);
    for (let qi = 0; qi < 30; qi++) {
      const src = records[Math.floor(rnd() * records.length)]!;
      const q = rec("q", mutate(src.address, Math.floor(rnd() * 15)), mutate(src.description, Math.floor(rnd() * 15)));
      const addrT = [0.7, 0.8, 0.9, 1.0][Math.floor(rnd() * 4)]!;
      const descT = [0.7, 0.8, 0.9, 1.0][Math.floor(rnd() * 4)]!;
      const got = catalog.findDuplicates(q, addrT, descT);
      const want = bruteForce(records, q, addrT, descT);
      assert.deepEqual(got, want, `round=${round} qi=${qi} t=${addrT}/${descT}`);
    }
  }
});
