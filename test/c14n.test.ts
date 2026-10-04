import assert from "node:assert";
import { describe, test } from "node:test";
import { canonicalizeDocument, canonicalizeElement } from "../src/c14n";
import { parseXml } from "../src/xml";

describe("exclusive C14N", () => {
  test("renders utilized namespaces and sorts attributes", () => {
    const doc = parseXml(
      `<doc xmlns="urn:default" xmlns:b="urn:bee" a="1" b:c="2"><b:child/></doc>`
    );
    assert.strictEqual(
      canonicalizeDocument(doc),
      `<doc xmlns="urn:default" xmlns:b="urn:bee" a="1" b:c="2"><b:child></b:child></doc>`
    );
  });

  test("does not render unused ancestor namespaces", () => {
    const doc = parseXml(
      `<root xmlns:unused="urn:u"><child xmlns:used="urn:s"><used:x/></child></root>`
    );
    assert.strictEqual(
      canonicalizeDocument(doc),
      `<root><child><used:x xmlns:used="urn:s"></used:x></child></root>`
    );
  });

  test("escapes text and attribute values", () => {
    const doc = parseXml(
      `<r a="&amp;&lt;&quot;&#x9;&#xA;&#xD;">&amp;&lt;&gt;&#xD;</r>`
    );
    assert.strictEqual(
      canonicalizeDocument(doc),
      `<r a="&amp;&lt;&quot;&#x9;&#xA;&#xD;">&amp;&lt;&gt;&#xD;</r>`
    );
  });

  test("omits the excluded element (enveloped-signature)", () => {
    const doc = parseXml(`<r><keep/><drop><x/></drop></r>`);
    const drop = doc.root.children.find(
      (c) => c.kind === "element" && c.localName === "drop"
    );
    assert.ok(drop && drop.kind === "element");
    assert.strictEqual(
      canonicalizeDocument(doc, {}, drop),
      `<r><keep></keep></r>`
    );
  });

  test("PrefixList #default pulls in the ancestor default namespace", () => {
    const doc = parseXml(
      `<root xmlns="urn:d" xmlns:q="urn:q"><q:sub q:a="1"/></root>`
    );
    const sub = doc.root.children[0];
    assert.ok(sub && sub.kind === "element");
    assert.strictEqual(
      canonicalizeElement(sub),
      `<q:sub xmlns:q="urn:q" q:a="1"></q:sub>`
    );
    assert.strictEqual(
      canonicalizeElement(sub, { inclusivePrefixes: ["#default"] }),
      `<q:sub xmlns="urn:d" xmlns:q="urn:q" q:a="1"></q:sub>`
    );
  });

  test("attribute sorting: no-namespace first, then by URI and local name", () => {
    const doc = parseXml(
      `<r xmlns:b="urn:b" xmlns:a="urn:a" z="1" b:y="2" a:x="3" m="4"/>`
    );
    assert.strictEqual(
      canonicalizeDocument(doc),
      `<r xmlns:a="urn:a" xmlns:b="urn:b" m="4" z="1" a:x="3" b:y="2"></r>`
    );
  });
});
