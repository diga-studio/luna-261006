import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDomain, extractDomain } from "../dist/index.js";

test("Unicode 域名与对应 Punycode 等价", () => {
  assert.equal(normalizeDomain("münchen.de"), "xn--mnchen-3ya.de");
  assert.equal(normalizeDomain("xn--mnchen-3ya.de"), "xn--mnchen-3ya.de");
  assert.equal(normalizeDomain("MÜNCHEN.de"), normalizeDomain("xn--mnchen-3ya.de"));
});

test("非过渡模式：ß 与 ss 不等价", () => {
  assert.equal(normalizeDomain("faß.de"), "xn--fa-hia.de");
  assert.notEqual(normalizeDomain("faß.de"), normalizeDomain("fass.de"));
});

test("允许并忽略一个末尾根点", () => {
  assert.equal(normalizeDomain("trash.test."), "trash.test");
  assert.equal(normalizeDomain("trash.test"), "trash.test");
});

test("ASCII 小写化与 STD3 规则", () => {
  assert.equal(normalizeDomain("Trash.TEST"), "trash.test");
  assert.throws(() => normalizeDomain("exa mple.com"));
  assert.throws(() => normalizeDomain(""));
  assert.throws(() => normalizeDomain("."));
});

test("extractDomain 取最后一个 @ 之后的部分", () => {
  assert.equal(extractDomain("user@trash.test"), "trash.test");
  assert.equal(extractDomain("trash.test"), "trash.test");
  assert.equal(extractDomain("a@b@trash.test"), "trash.test");
});
