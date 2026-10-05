import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStamp, normalizeStamp, StampError } from "../src/index.ts";
import { parseXml } from "../src/xml.ts";
import type { XmlElement } from "../src/xml.ts";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

const SVG_NS = "http://www.w3.org/2000/svg";

function head(extra = ""): string {
  return `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100"${extra}>`;
}

interface Leaf {
  tag: string;
  transforms: string[];
  fill: string | undefined;
  stroke: string | undefined;
  strokeWidth: string | undefined;
  opacity: string | undefined;
  attrs: Map<string, string>;
}

/** Walks normalized output and returns leaf shapes with inherited context. */
function leaves(svg: string): Leaf[] {
  const root = parseXml(bytes(svg));
  const out: Leaf[] = [];
  const attr = (el: XmlElement, name: string): string | undefined =>
    el.attrs.find((a) => a.local === name)?.value;
  const walk = (
    el: XmlElement,
    ctx: { transforms: string[]; fill?: string; stroke?: string; strokeWidth?: string; opacity?: string },
  ) => {
    const t = attr(el, "transform");
    const next = {
      transforms: t === undefined ? ctx.transforms : [...ctx.transforms, t],
      fill: attr(el, "fill") ?? ctx.fill,
      stroke: attr(el, "stroke") ?? ctx.stroke,
      strokeWidth: attr(el, "stroke-width") ?? ctx.strokeWidth,
      opacity: attr(el, "opacity") ?? ctx.opacity,
    };
    if (el.children.length === 0) {
      out.push({
        tag: el.local,
        transforms: next.transforms,
        fill: next.fill,
        stroke: next.stroke,
        strokeWidth: next.strokeWidth,
        opacity: next.opacity,
        attrs: new Map(el.attrs.map((a) => [a.local, a.value])),
      });
      return;
    }
    for (const child of el.children) walk(child, next);
  };
  walk(root, { transforms: [] });
  return out;
}

test("forward references and multi-layer use composition", () => {
  const doc =
    head(' viewBox="0 0 100 100"') +
    `<defs><g id="shape"><rect x="0" y="0" width="10" height="10"/></g>` +
    `<g id="combo" transform="rotate(10)"><use xlink:href="#shape" y="3" stroke="#00ff00"/></g></defs>` +
    `<use href="#combo" x="5" y="7" fill="#ff0000" transform="scale(2)"/>` +
    `</svg>`;
  const info = validateStamp(bytes(doc));
  assert.deepEqual(info, { width: 100, height: 100, nodeCount: 5 });
  const out = normalizeStamp(bytes(doc));
  assert.ok(!out.includes("<use"));
  assert.ok(!out.includes("<defs"));
  assert.ok(!out.includes("href"));
  assert.ok(!out.includes(" id="));
  assert.ok(out.includes('viewBox="0 0 100 100"'));
  const leafs = leaves(out);
  assert.equal(leafs.length, 1);
  const rect = leafs[0];
  assert.equal(rect.tag, "rect");
  // Outermost first: use transform+offset, then target g transform, then inner use offset.
  assert.deepEqual(rect.transforms, ["scale(2) translate(5 7)", "rotate(10)", "translate(0 3)"]);
  assert.equal(rect.fill, "#ff0000");
  assert.equal(rect.stroke, "#00ff00");
});

test("target's own declarations win over use styles", () => {
  const doc =
    head() +
    `<defs><g id="t" fill="#0000ff" stroke-width="2"><rect width="5" height="5" fill="#00ff00"/></g></defs>` +
    `<use href="#t" fill="#ff0000" stroke="#111111" stroke-width="9"/>` +
    `</svg>`;
  const [rect] = leaves(normalizeStamp(bytes(doc)));
  assert.equal(rect.fill, "#00ff00"); // rect's own fill wins
  assert.equal(rect.stroke, "#111111"); // inherited from use through target g
  assert.equal(rect.strokeWidth, "2"); // target g's own declaration wins
});

test("repeated references to one target stay independent", () => {
  const doc =
    head() +
    `<defs><g id="t"><circle cx="1" cy="2" r="3"/></g></defs>` +
    `<use href="#t" x="10" fill="#ff0000"/>` +
    `<use href="#t" y="20" fill="#00ff00" opacity="0.5"/>` +
    `</svg>`;
  const leafs = leaves(normalizeStamp(bytes(doc)));
  assert.equal(leafs.length, 2);
  assert.deepEqual(leafs[0].transforms, ["translate(10 0)"]);
  assert.equal(leafs[0].fill, "#ff0000");
  assert.equal(leafs[0].opacity, undefined);
  assert.deepEqual(leafs[1].transforms, ["translate(0 20)"]);
  assert.equal(leafs[1].fill, "#00ff00");
  assert.equal(leafs[1].opacity, "0.5");
  for (const leaf of leafs) {
    assert.equal(leaf.attrs.get("cx"), "1");
    assert.equal(leaf.attrs.get("r"), "3");
  }
});

test("target's original ancestors do not leak into instances", () => {
  const doc =
    head() +
    `<defs><g fill="#123456" transform="scale(9)"><g id="t"><rect width="4" height="4"/></g></g></defs>` +
    `<use href="#t"/>` +
    `</svg>`;
  const [rect] = leaves(normalizeStamp(bytes(doc)));
  assert.equal(rect.fill, undefined);
  assert.deepEqual(rect.transforms, []);
});

test("renamed namespace prefixes resolve by URI", () => {
  const doc =
    `<s:svg xmlns:s="${SVG_NS}" xmlns:xl="http://www.w3.org/1999/xlink" width="10" height="20">` +
    `<s:defs><s:rect id="r" width="1" height="1"/></s:defs>` +
    `<s:use xl:href="#r"/>` +
    `</s:svg>`;
  const info = validateStamp(bytes(doc));
  assert.deepEqual(info, { width: 10, height: 20, nodeCount: 2 });
  const out = normalizeStamp(bytes(doc));
  assert.ok(out.startsWith(`<svg xmlns="${SVG_NS}"`));
  const [rect] = leaves(out);
  assert.equal(rect.tag, "rect");
});

test("dual href must agree after XML decoding", () => {
  const ok =
    head() +
    `<defs><rect id="a" width="1" height="1"/></defs>` +
    `<use href="&#35;a" xlink:href="#a"/>` +
    `</svg>`;
  assert.doesNotThrow(() => normalizeStamp(bytes(ok)));
  const conflict =
    head() +
    `<defs><rect id="a" width="1" height="1"/><rect id="b" width="1" height="1"/></defs>` +
    `<use href="#a" xlink:href="#b"/>` +
    `</svg>`;
    assert.throws(() => validateStamp(bytes(conflict)), StampError);
  assert.throws(() => normalizeStamp(bytes(conflict)), StampError);
});

test("reachable reference cycles are rejected", () => {
  const doc =
    head() +
    `<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs>` +
    `<use href="#a"/>` +
    `</svg>`;
  assert.throws(() => validateStamp(bytes(doc)), /cycle/);
  const selfRef =
    head() + `<g id="s"><use href="#s"/></g>` + `</svg>`;
  assert.throws(() => validateStamp(bytes(selfRef)), /cycle/);
});

test("unreferenced cycles inside defs are accepted", () => {
  const doc =
    head() +
    `<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g><rect id="ok" width="1" height="1"/></defs>` +
    `<use href="#ok"/>` +
    `</svg>`;
  const info = validateStamp(bytes(doc));
  assert.equal(info.nodeCount, 2);
  assert.doesNotThrow(() => normalizeStamp(bytes(doc)));
});

test("3000-deep legal reference chain succeeds", () => {
  const parts = [head(), "<defs>"];
  for (let i = 0; i < 3000; i++) {
    const inner = i === 0 ? `<rect width="1" height="1"/>` : `<use href="#c${i - 1}"/>`;
    parts.push(`<g id="c${i}">${inner}</g>`);
  }
  parts.push("</defs>", `<use href="#c2999"/>`, "</svg>");
  const doc = parts.join("");
  const info = validateStamp(bytes(doc));
  assert.equal(info.nodeCount, 6001);
  const out = normalizeStamp(bytes(doc));
  assert.ok(!out.includes("<use"));
  assert.equal(leaves(out).length, 1);
});

test("exponential blowup is rejected in a controlled way", () => {
  const parts = [head(), "<defs>", `<g id="e0"><rect width="1" height="1"/></g>`];
  for (let i = 1; i <= 13; i++) {
    parts.push(`<g id="e${i}"><use href="#e${i - 1}"/><use href="#e${i - 1}"/></g>`);
  }
  parts.push("</defs>", `<use href="#e13"/>`, "</svg>");
  const doc = parts.join("");
  assert.ok(doc.length < 4096, "input stays small");
  assert.throws(() => validateStamp(bytes(doc)), /10000/);
  assert.throws(() => normalizeStamp(bytes(doc)), /10000/);
});

test("output exceeding 4 MiB is rejected", () => {
  const d = "M0 0" + "L1 1".repeat(100000); // ~400 KB path data
  const uses = `<use href="#big"/>`.repeat(11);
  const doc = head() + `<defs><path id="big" d="${d}"/></defs>` + uses + `</svg>`;
  assert.ok(bytes(doc).length <= 512 * 1024);
  assert.throws(() => normalizeStamp(bytes(doc)), /4 MiB/);
  assert.throws(() => validateStamp(bytes(doc)), /4 MiB/);
});

test("input exceeding 512 KiB is rejected", () => {
  const pad = " ".repeat(512 * 1024);
  const doc = head() + pad + `</svg>`;
  assert.throws(() => validateStamp(bytes(doc)), /512 KiB/);
});

test("validate and normalize agree on accept/reject", () => {
  const cases = [
    head() + `<rect width="1" height="1"/>` + `</svg>`, // ok
    head() + `<defs><g id="x"><circle cx="1" cy="1" r="1"/></g></defs><use href="#x" x="2"/></svg>`, // ok
    head() + `<use href="#missing"/></svg>`, // dangling
    head() + `<defs><rect id="d" width="1" height="1"/><rect id="d" width="2" height="2"/></defs></svg>`, // dup id
    head() + `<image href="http://evil.example/x.png"/></svg>`, // unsupported element
    head() + `<rect width="1" height="1" fill="red"/></svg>`, // bad color
    head() + `<rect width="1" height="1" fill="#fff"/></svg>`, // short hex
    head() + `<rect width="1" height="1" fill="url(#g)"/></svg>`, // paint server ref
    head() + `<rect width="1" height="1" onclick="x()"/></svg>`, // scriptable attr
    head() + `<g><svg width="1" height="1"/></g></svg>`, // nested svg
    head() + `<g><defs/></g></svg>`, // defs not under root
    head() + `<use/></svg>`, // use without href
    head() + `<use href="other.svg#a"/></svg>`, // external ref
    head() + `<use href="#"/></svg>`, // empty fragment
    `<svg xmlns="${SVG_NS}" width="0" height="10"></svg>`, // zero width
    `<svg xmlns="${SVG_NS}" width="4097" height="10"></svg>`, // too large
    `<svg xmlns="${SVG_NS}" width="10" height="10.5"></svg>`, // non-integer
    `<svg xmlns="${SVG_NS}" height="10"></svg>`, // missing width
    `<svg xmlns="${SVG_NS}" width="10" height="10"><rect width="1" height="1"><g/></rect></svg>`, // shape children
    `<svg xmlns="${SVG_NS}" width="10" height="10"><text>hi</text></svg>`, // text element
    `<svg xmlns="${SVG_NS}" width="10" height="10"><a href="#x"><rect width="1" height="1"/></a></svg>`, // link element
  ];
  for (const doc of cases) {
    let validateErr: unknown = null;
    let normalizeErr: unknown = null;
    try {
      validateStamp(bytes(doc));
    } catch (err) {
      validateErr = err;
    }
    try {
      normalizeStamp(bytes(doc));
    } catch (err) {
      normalizeErr = err;
    }
    assert.equal(
      validateErr === null,
      normalizeErr === null,
      "accept/reject mismatch for: " + doc.slice(0, 80),
    );
  }
});

test("node counting excludes root and defs, includes instantiated targets", () => {
  const doc =
    head() +
    `<defs><g id="t"><rect width="1" height="1"/><circle cx="0" cy="0" r="1"/></g><rect id="unused" width="1" height="1"/></defs>` +
    `<rect width="2" height="2"/>` +
    `<use href="#t"/>` +
    `</svg>`;
  // rect(1) + use(1 + g(1 + 2 shapes)) = 1 + 4 = 5
  assert.equal(validateStamp(bytes(doc)).nodeCount, 5);
});

test("opacity on use becomes group opacity on the instance", () => {
  const doc =
    head() +
    `<defs><g id="t"><rect width="1" height="1"/></g></defs>` +
    `<use href="#t" opacity="0.5"/>` +
    `</svg>`;
  const [rect] = leaves(normalizeStamp(bytes(doc)));
  assert.equal(rect.opacity, "0.5");
});

test("output contains no use, defs, id or reference attributes", () => {
  const doc =
    head() +
    `<defs><g id="t"><rect id="r" width="1" height="1"/></g></defs>` +
    `<use href="#t" x="1"/>` +
    `</svg>`;
  const out = normalizeStamp(bytes(doc));
  assert.ok(!/<use[\s>]/.test(out));
  assert.ok(!/<defs[\s>]/.test(out));
  assert.ok(!/\sid=/.test(out));
  assert.ok(!/href/.test(out));
});

test("root keeps px suffix, transform and inherited styles", () => {
  const doc =
    `<svg xmlns="${SVG_NS}" width="64px" height="32" transform="scale(2)" fill="#010203">` +
    `<rect width="1" height="1"/>` +
    `</svg>`;
  const info = validateStamp(bytes(doc));
  assert.deepEqual(info, { width: 64, height: 32, nodeCount: 1 });
  const out = normalizeStamp(bytes(doc));
  assert.ok(out.includes('width="64px"'));
  assert.ok(out.includes('transform="scale(2)"'));
  const [rect] = leaves(out);
  assert.equal(rect.fill, "#010203");
});

test("deeply nested containers succeed without stack overflow", () => {
  const depth = 5000;
  const doc = head() + "<g>".repeat(depth) + `<rect width="1" height="1"/>` + "</g>".repeat(depth) + "</svg>";
  const info = validateStamp(bytes(doc));
  assert.equal(info.nodeCount, depth + 1);
  assert.doesNotThrow(() => normalizeStamp(bytes(doc)));
});

test("use may reference a visible sibling shape", () => {
  const doc =
    head() +
    `<rect id="r" width="2" height="2" fill="#ff0000"/>` +
    `<use href="#r" x="10"/>` +
    `</svg>`;
  const leafs = leaves(normalizeStamp(bytes(doc)));
  assert.equal(leafs.length, 2);
  assert.deepEqual(leafs[0].transforms, []);
  assert.deepEqual(leafs[1].transforms, ["translate(10 0)"]);
  assert.equal(leafs[1].fill, "#ff0000"); // target's own fill, not polluted
});

test("empty svg is accepted", () => {
  const info = validateStamp(bytes(head() + "</svg>"));
  assert.deepEqual(info, { width: 100, height: 100, nodeCount: 0 });
  assert.equal(normalizeStamp(bytes(head() + "</svg>")), `<svg xmlns="${SVG_NS}" width="100" height="100"></svg>`);
});
