import assert from "node:assert";
import { describe, test } from "node:test";
import { parseXml, textContent, XmlParseError } from "../src/xml";

describe("XML parser", () => {
  test("parses elements, attributes, text and namespaces", () => {
    const doc = parseXml(
      `<p:root xmlns:p="urn:p" xmlns="urn:d" a="1" p:b="2">hi<child>x</child></p:root>`
    );
    assert.strictEqual(doc.root.namespaceURI, "urn:p");
    assert.strictEqual(doc.root.localName, "root");
    const child = doc.root.children.find((c) => c.kind === "element");
    assert.ok(child && child.kind === "element");
    assert.strictEqual(child.namespaceURI, "urn:d");
    assert.strictEqual(textContent(doc.root), "hix");
  });

  test("resolves predefined entities and character references", () => {
    const doc = parseXml(`<r a="&lt;&amp;&#x41;&#66;">&gt;&quot;&apos;</r>`);
    assert.strictEqual(doc.root.attributes[0]!.value, "<&AB");
    assert.strictEqual(textContent(doc.root), `>"'`);
  });

  test("normalizes line endings and attribute whitespace", () => {
    const doc = parseXml(`<r a="x\r\ny\tz">a\rb</r>`);
    assert.strictEqual(doc.root.attributes[0]!.value, "x y z");
    assert.strictEqual(textContent(doc.root), "a\nb");
  });

  test("rejects DOCTYPE, entities, and malformed input", () => {
    const bad = [
      `<!DOCTYPE r><r/>`,
      `<!DOCTYPE r [<!ENTITY e "x">]><r>&e;</r>`,
      `<r>&undefined;</r>`,
      `<r>&#xD800;</r>`,
      `<r><![CDATA[unterminated</r>`,
      `<r><!-- bad -- comment --></r>`,
      `<r a="1" a="2"/>`,
      `<r xmlns:a="urn:x" xmlns:b="urn:x"><x a:c="1" b:c="2"/></r>`,
      `<q:r/>`,
      `<r></q>`,
      `<r/><r/>`,
      `<r>text</r> trailing`,
      `<r xmlns:xml="urn:wrong"/>`,
      `<r xmlns:xmlns="urn:x"/>`,
      `<r xmlns:p=""/>`,
    ];
    for (const input of bad) {
      assert.throws(() => parseXml(input), XmlParseError, JSON.stringify(input));
    }
  });

  test("rejects deeply nested documents without crashing", () => {
    const deep = `${"<a>".repeat(10000)}${"</a>".repeat(10000)}`;
    assert.throws(() => parseXml(deep), XmlParseError);
  });

  test("handles CDATA and comments", () => {
    const doc = parseXml(`<r><!-- c --><![CDATA[a<b>&amp;]]></r>`);
    assert.strictEqual(textContent(doc.root), "a<b>&amp;");
  });
});
