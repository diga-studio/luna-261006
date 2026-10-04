import { test } from "node:test";
import assert from "node:assert/strict";
import { CsvParser } from "../src/csv.js";

function parseAll(chunks: Buffer[]): { fields: string[]; bytes: number }[] {
  const parser = new CsvParser();
  const out: { fields: string[]; bytes: number }[] = [];
  for (const chunk of chunks) {
    parser.feed(chunk);
    let rec;
    while ((rec = parser.nextRecord()) !== null) {
      out.push({ fields: rec.fields, bytes: rec.bytesConsumed });
    }
  }
  parser.setEof();
  let rec;
  while ((rec = parser.nextRecord()) !== null) {
    out.push({ fields: rec.fields, bytes: rec.bytesConsumed });
  }
  return out;
}

test("simple LF records", () => {
  const recs = parseAll([Buffer.from("a,b\nc,d\n", "utf8")]);
  assert.deepEqual(recs.map((r) => r.fields), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(recs.map((r) => r.bytes), [4, 4]);
});

test("no trailing newline at EOF", () => {
  const recs = parseAll([Buffer.from("a,b\nc,d", "utf8")]);
  assert.deepEqual(recs.map((r) => r.fields), [["a", "b"], ["c", "d"]]);
});

test("CRLF terminators", () => {
  const recs = parseAll([Buffer.from("a,b\r\nc,d\r\n", "utf8")]);
  assert.deepEqual(recs.map((r) => r.fields), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(recs.map((r) => r.bytes), [5, 5]);
});

test("lone CR terminator", () => {
  const recs = parseAll([Buffer.from("a,b\rc,d", "utf8")]);
  assert.deepEqual(recs.map((r) => r.fields), [["a", "b"], ["c", "d"]]);
});

test("CR split across chunks", () => {
  const recs = parseAll([Buffer.from("a,b\r", "utf8"), Buffer.from("\nc,d", "utf8")]);
  assert.deepEqual(recs.map((r) => r.fields), [["a", "b"], ["c", "d"]]);
  assert.equal(recs[0].bytes, 5);
});

test("quoted field with comma, newline and escaped quotes", () => {
  const recs = parseAll([Buffer.from('"x,""y""\nz",b\n', "utf8")]);
  assert.deepEqual(recs.map((r) => r.fields), [['x,"y"\nz', "b"]]);
});

test("BOM is skipped and counted once", () => {
  const recs = parseAll([Buffer.from("﻿a,b\nc,d\n", "utf8")]);
  assert.deepEqual(recs.map((r) => r.fields), [["a", "b"], ["c", "d"]]);
  assert.equal(recs[0].bytes, 3 + 4);
  assert.equal(recs[1].bytes, 4);
});

test("multibyte utf8 split across chunk boundaries", () => {
  const full = Buffer.from("汉字,描述\n第二,行\n", "utf8");
  const recs: { fields: string[] }[] = [];
  for (let cut = 1; cut < full.length; cut++) {
    const got = parseAll([full.subarray(0, cut), full.subarray(cut)]);
    recs.push(...got.map((g) => ({ fields: g.fields })));
    assert.deepEqual(
      got.map((g) => g.fields),
      [
        ["汉字", "描述"],
        ["第二", "行"],
      ],
      `cut at ${cut}`,
    );
  }
});

test("empty fields and trailing empty field", () => {
  const recs = parseAll([Buffer.from(",,\na,,\n", "utf8")]);
  assert.deepEqual(recs.map((r) => r.fields), [
    ["", "", ""],
    ["a", "", ""],
  ]);
});

test("quoted empty field", () => {
  const recs = parseAll([Buffer.from('"",x\n', "utf8")]);
  assert.deepEqual(recs.map((r) => r.fields), [["", "x"]]);
});

test("byte offsets track consumed input exactly", () => {
  const data = "h1,h2\na,\"m\nn\"\nb,c";
  const recs = parseAll([Buffer.from(data, "utf8")]);
  const total = recs.reduce((acc, r) => acc + r.bytes, 0);
  assert.equal(total, Buffer.byteLength(data, "utf8"));
});
