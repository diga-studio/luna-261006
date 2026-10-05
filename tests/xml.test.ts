import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml, XmlError } from "../src/xml.ts";

const enc = (s: string) => new TextEncoder().encode(s);

test("parses simple document with namespaces", () => {
  const root = parseXml(enc('<svg xmlns="http://www.w3.org/2000/svg"><g id="a"/></svg>'));
  assert.equal(root.local, "svg");
  assert.equal(root.ns, "http://www.w3.org/2000/svg");
  assert.equal(root.children[0].attrs[0].value, "a");
});

test("accepts BOM, declaration, comments, numeric entities", () => {
  const doc = "﻿<?xml version=\"1.0\" encoding=\"UTF-8\"?><!-- hi --><svg xmlns=\"http://www.w3.org/2000/svg\" data-x=\"&#65;&amp;&lt;\"/>";
  const root = parseXml(enc(doc));
  const attr = root.attrs.find((a) => a.local === "data-x");
  assert.equal(attr?.value, "A&<");
});

test("rejects DTD, PI, CDATA, custom entities", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  assert.throws(() => parseXml(enc("<!DOCTYPE svg>" + svg)), XmlError);
  assert.throws(() => parseXml(enc('<?pi data?>' + svg)), XmlError);
  assert.throws(() => parseXml(enc('<!DOCTYPE svg [<!ENTITY x "y">]>' + svg)), XmlError);
  assert.throws(() => parseXml(enc('<svg xmlns="http://www.w3.org/2000/svg" a="&custom;"/>')), XmlError);
});

test("rejects mismatched tags, text content, duplicate attributes", () => {
  const ns = 'xmlns="http://www.w3.org/2000/svg"';
  assert.throws(() => parseXml(enc(`<svg ${ns}><g></svg>`)), XmlError);
  assert.throws(() => parseXml(enc(`<svg ${ns}>hello</svg>`)), XmlError);
  assert.throws(() => parseXml(enc(`<svg ${ns}><g id="a" id="b"/></svg>`)), XmlError);
});

test("resolves renamed prefixes by URI, not by prefix string", () => {
  const root = parseXml(enc('<s:svg xmlns:s="http://www.w3.org/2000/svg" xmlns:xl="http://www.w3.org/1999/xlink"><s:use xl:href="#a"/></s:svg>'));
  assert.equal(root.local, "svg");
  const use = root.children[0];
  assert.equal(use.local, "use");
  assert.equal(use.attrs[0].ns, "http://www.w3.org/1999/xlink");
  assert.equal(use.attrs[0].local, "href");
});

test("rejects elements without namespace and unbound prefixes", () => {
  assert.throws(() => parseXml(enc("<svg/>")), XmlError);
  assert.throws(() => parseXml(enc('<svg xmlns="http://www.w3.org/2000/svg"><foo:bar/></svg>')), XmlError);
});

test("rejects invalid numeric entities and bad UTF-8", () => {
  const ns = 'xmlns="http://www.w3.org/2000/svg"';
  assert.throws(() => parseXml(enc(`<svg ${ns} a="&#0;"/>`)), XmlError);
  assert.throws(() => parseXml(new Uint8Array([0xff, 0xfe, 0x41])), XmlError);
});
