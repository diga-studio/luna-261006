import { test } from "node:test";
import assert from "node:assert/strict";
import { toCodePoints, levenshtein, similarity } from "../src/levenshtein.js";

test("toCodePoints 按码点计数，非 BMP 字符算 1 个", () => {
  assert.equal(toCodePoints("").length, 0);
  assert.equal(toCodePoints("abc").length, 3);
  assert.equal(toCodePoints("😀").length, 1); // UTF-16 长度为 2
  assert.equal(toCodePoints("中😀文").length, 3);
});

test("levenshtein 基本情形", () => {
  const cp = toCodePoints;
  assert.equal(levenshtein(cp(""), cp("")), 0);
  assert.equal(levenshtein(cp(""), cp("abc")), 3);
  assert.equal(levenshtein(cp("abc"), cp("")), 3);
  assert.equal(levenshtein(cp("abc"), cp("abc")), 0);
  assert.equal(levenshtein(cp("kitten"), cp("sitting")), 3);
  assert.equal(levenshtein(cp("flaw"), cp("lawn")), 2);
});

test("相邻字符交换不是一次编辑", () => {
  const cp = toCodePoints;
  assert.equal(levenshtein(cp("ab"), cp("ba")), 2);
  assert.equal(levenshtein(cp("abcd"), cp("abdc")), 2);
});

test("非 BMP 字符按单个码点计编辑", () => {
  const cp = toCodePoints;
  assert.equal(levenshtein(cp("😀"), cp("😃")), 1);
  assert.equal(levenshtein(cp("a😀b"), cp("a😃b")), 1);
  assert.equal(levenshtein(cp("😀😀"), cp("😀")), 1);
});

test("maxDistance 截断与精确值一致", () => {
  const cp = toCodePoints;
  assert.equal(levenshtein(cp("kitten"), cp("sitting"), 3), 3);
  assert.ok(levenshtein(cp("kitten"), cp("sitting"), 2) > 2);
  assert.equal(levenshtein(cp("abc"), cp("abc"), 0), 0);
  assert.ok(levenshtein(cp("abc"), cp("abd"), 0) > 0);
});

test("similarity 空串规则", () => {
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("", "a"), 0);
  assert.equal(similarity("a", ""), 0);
});

test("similarity 定义：1 - 距离 / 较大码点长度", () => {
  assert.equal(similarity("abc", "abc"), 1);
  assert.equal(similarity("abcd", "abed"), 1 - 1 / 4);
  assert.equal(similarity("kitten", "sitting"), 1 - 3 / 7);
  assert.equal(similarity("😀", "😃"), 0);
  assert.equal(similarity("a😀", "a😃"), 1 - 1 / 2);
});
