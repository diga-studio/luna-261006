import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CsvParser } from "../src/csv.js";
import { makeTmpDir } from "./helpers.js";

function writeFile(name: string, content: Buffer | string): string {
  const dir = makeTmpDir("csv");
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function readAll(p: string, offset = 0): Array<{ fields: string[]; nextOffset: number }> {
  const parser = new CsvParser(p, offset);
  const out: Array<{ fields: string[]; nextOffset: number }> = [];
  try {
    let rec;
    while ((rec = parser.next()) !== null) out.push(rec);
  } finally {
    parser.close();
  }
  return out;
}

test("基础字段与表头", () => {
  const p = writeFile("a.csv", "external_id,category,description\nA,harassment,x\n");
  const recs = readAll(p);
  assert.deepStrictEqual(recs.map((r) => r.fields), [
    ["external_id", "category", "description"],
    ["A", "harassment", "x"],
  ]);
});

test("BOM 被跳过", () => {
  const p = writeFile("bom.csv", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\nc,d\n")]));
  const recs = readAll(p);
  assert.deepStrictEqual(recs[0]!.fields, ["a", "b"]);
});

test("带引号字段：内嵌逗号、换行、转义引号", () => {
  const p = writeFile("q.csv", '"a,""b""","x\ny",z\n');
  const recs = readAll(p);
  assert.deepStrictEqual(recs[0]!.fields, ['a,"b"', "x\ny", "z"]);
});

test("CRLF 与 LF 混合", () => {
  const p = writeFile("eol.csv", "a,b\r\nc,d\ne,f\r\n");
  const recs = readAll(p);
  assert.deepStrictEqual(recs.map((r) => r.fields), [["a", "b"], ["c", "d"], ["e", "f"]]);
});

test("末记录无换行", () => {
  const p = writeFile("notrail.csv", "a,b\nc,d");
  const recs = readAll(p);
  assert.deepStrictEqual(recs.map((r) => r.fields), [["a", "b"], ["c", "d"]]);
});

test("末记录以 CR 结尾", () => {
  const p = writeFile("cr.csv", "a,b\rc,d\r");
  const recs = readAll(p);
  assert.deepStrictEqual(recs.map((r) => r.fields), [["a", "b"], ["c", "d"]]);
});

test("多字节字符不做归一化", () => {
  const p = writeFile("mb.csv", "汉字,🚀,é\n");
  const recs = readAll(p);
  assert.deepStrictEqual(recs[0]!.fields, ["汉字", "🚀", "é"]);
});

test("空字段与空文件", () => {
  const p = writeFile("empty-fields.csv", "a,,c\n,,\n");
  const recs = readAll(p);
  assert.deepStrictEqual(recs.map((r) => r.fields), [["a", "", "c"], ["", "", ""]]);
  const empty = writeFile("empty.csv", "");
  assert.deepStrictEqual(readAll(empty), []);
});

test("nextOffset 可从中间恢复且与全量解析一致", () => {
  // 构造跨缓冲边界的记录（记录长度接近 64KiB）
  const big = "y".repeat(70 * 1024);
  const lines = ["h1,h2,h3\n", `a,"multi\nline",b\n`, `c,${big},d\n`, `e,"q""q",f`];
  const p = writeFile("resume.csv", lines.join(""));
  const all = readAll(p);
  assert.strictEqual(all.length, 4);
  // 从每条记录边界恢复，后续记录必须一致
  for (let i = 1; i < all.length; i++) {
    const fromOffset = readAll(p, all[i - 1]!.nextOffset);
    assert.deepStrictEqual(
      fromOffset.map((r) => r.fields),
      all.slice(i).map((r) => r.fields),
      `resume from record ${i}`
    );
    assert.deepStrictEqual(
      fromOffset.map((r) => r.nextOffset),
      all.slice(i).map((r) => r.nextOffset),
      `offsets from record ${i}`
    );
  }
});

test("跨块引号与转义", () => {
  // 让引号恰好落在 64KiB 块边界附近
  const pad = "p".repeat(64 * 1024 - 3);
  const p = writeFile("edge.csv", `${pad},"ab""\ncd",z\n`);
  const recs = readAll(p);
  assert.deepStrictEqual(recs[0]!.fields, [pad, 'ab"\ncd', "z"]);
});
