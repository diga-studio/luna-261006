import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStamp, validateStamp, StampError } from "../src/index";
import { parseXml } from "../src/xml";
import { XmlElement } from "../src/model";

const SVG_NS = "http://www.w3.org/2000/svg";
const H = `xmlns="${SVG_NS}" width="100" height="200"`;

function bytes(s: string): Uint8Array {
  return Buffer.from(s, "utf8");
}

/** A visible shape with its fully inherited presentation context. */
interface FlatShape {
  tag: string;
  fill: string | null;
  stroke: string | null;
  strokeWidth: string | null;
  opacity: string | null;
  /** Transform list, outermost first. */
  transforms: string[];
  attrs: Record<string, string>;
}

interface Ctx {
  fill: string | null;
  stroke: string | null;
  strokeWidth: string | null;
  opacity: string | null;
  transforms: string[];
}

function attr(el: XmlElement, local: string): string | null {
  for (const a of el.attrs) if (a.ns === null && a.local === local) return a.value;
  return null;
}

/** Flatten a normalized SVG into shapes with effective inherited style. */
function flatten(svg: string): FlatShape[] {
  const root = parseXml(bytes(svg));
  const out: FlatShape[] = [];
  const walk = (el: XmlElement, ctx: Ctx): void => {
    const next: Ctx = {
      fill: attr(el, "fill") ?? ctx.fill,
      stroke: attr(el, "stroke") ?? ctx.stroke,
      strokeWidth: attr(el, "stroke-width") ?? ctx.strokeWidth,
      opacity: attr(el, "opacity") ?? ctx.opacity,
      transforms: ctx.transforms,
    };
    const ownTransform = attr(el, "transform");
    if (ownTransform !== null) next.transforms = [...ctx.transforms, ownTransform];
    if (el.local === "path" || el.local === "rect" || el.local === "circle") {
      const attrs: Record<string, string> = {};
      for (const a of el.attrs) if (a.ns === null) attrs[a.local] = a.value;
      out.push({
        tag: el.local,
        fill: next.fill,
        stroke: next.stroke,
        strokeWidth: next.strokeWidth,
        opacity: next.opacity,
        transforms: next.transforms,
        attrs,
      });
    }
    for (const child of el.children) walk(child, next);
  };
  walk(root, { fill: null, stroke: null, strokeWidth: null, opacity: null, transforms: [] });
  return out;
}

function assertClean(svg: string): void {
  assert.ok(!svg.includes("<use"), "no use elements");
  assert.ok(!svg.includes("<defs"), "no defs elements");
  assert.ok(!svg.includes("id="), "no id attributes");
  assert.ok(!svg.includes("href"), "no reference attributes");
}

test("forward references and nested use compose effective style and transform", () => {
  const src = `<svg ${H} viewBox="0 0 100 200">` +
    `<use href="#layer1" x="5" fill="#111111"/>` +
    `<defs>` +
    `<g id="layer1" transform="translate(1 1)">` +
    `<rect width="10" height="20"/>` +
    `<use href="#layer2" y="7" fill="#222222" stroke="#444444"/>` +
    `</g>` +
    `<g id="layer2">` +
    `<circle r="3" fill="#333333"/>` +
    `<path d="M0 0h1"/>` +
    `</g>` +
    `</defs></svg>`;
  const info = validateStamp(bytes(src));
  assert.deepEqual(info, { width: 100, height: 200, nodes: 7 });

  const svg = normalizeStamp(bytes(src));
  assertClean(svg);
  const shapes = flatten(svg);
  assert.equal(shapes.length, 3);

  const rect = shapes.find((s) => s.tag === "rect")!;
  assert.equal(rect.fill, "#111111", "rect inherits fill from outer use");
  assert.deepEqual(rect.transforms, ["translate(5)", "translate(1 1)"]);

  const circle = shapes.find((s) => s.tag === "circle")!;
  assert.equal(circle.fill, "#333333", "target's own fill wins over use fill");
  assert.deepEqual(circle.transforms, ["translate(5)", "translate(1 1)", "translate(0 7)"]);

  const path = shapes.find((s) => s.tag === "path")!;
  assert.equal(path.fill, "#222222", "path inherits fill from inner use");
  assert.equal(path.stroke, "#444444", "path inherits stroke from inner use");
  assert.deepEqual(path.transforms, ["translate(5)", "translate(1 1)", "translate(0 7)"]);
});

test("use transform applies outside the x/y translation", () => {
  const src = `<svg ${H}><use href="#t" transform="scale(2)" x="10" y="20"/>` +
    `<defs><g id="t" transform="rotate(45)"><rect width="1" height="1"/></g></defs></svg>`;
  const [rect] = flatten(normalizeStamp(bytes(src)));
  assert.deepEqual(rect!.transforms, ["scale(2) translate(10 20)", "rotate(45)"]);
});

test("opacity stays a group effect on the expansion wrapper", () => {
  const src = `<svg ${H}><use href="#t" opacity="0.5"/>` +
    `<defs><g id="t"><rect width="1" height="1"/><circle r="1"/></g></defs></svg>`;
  const shapes = flatten(normalizeStamp(bytes(src)));
  assert.equal(shapes.length, 2);
  for (const s of shapes) assert.equal(s.opacity, "0.5");
});

test("repeated references to one target do not pollute each other", () => {
  const src = `<svg ${H}>` +
    `<use href="#t" x="1" fill="#ff0000"/>` +
    `<use href="#t" x="2"/>` +
    `<defs><g id="t"><rect width="1" height="1"/></g></defs></svg>`;
  const shapes = flatten(normalizeStamp(bytes(src)));
  assert.equal(shapes.length, 2);
  assert.equal(shapes[0]!.fill, "#ff0000");
  assert.deepEqual(shapes[0]!.transforms, ["translate(1)"]);
  assert.equal(shapes[1]!.fill, null, "second instance keeps its own (unset) style");
  assert.deepEqual(shapes[1]!.transforms, ["translate(2)"]);
});

test("namespace prefixes are resolved by URI, not by spelling", () => {
  const src = `<s:svg xmlns:s="${SVG_NS}" width="10" height="10">` +
    `<s:use href="#a"/><s:defs><s:g id="a"><s:rect width="1" height="1"/></s:g></s:defs></s:svg>`;
  const svg = normalizeStamp(bytes(src));
  assertClean(svg);
  assert.equal(flatten(svg).length, 1);
});

test("elements outside the SVG namespace are rejected", () => {
  assert.throws(() => validateStamp(bytes(`<svg width="1" height="1"/>`)), StampError);
  assert.throws(
    () => validateStamp(bytes(`<svg xmlns="http://example.com" width="1" height="1"/>`)),
    StampError,
  );
});

test("dual href attributes must agree after XML decoding", () => {
  const XL = `xmlns:xlink="http://www.w3.org/1999/xlink"`;
  const ok = `<svg ${H} ${XL}><use href="#a" xlink:href="#a"/><defs><g id="a"><rect width="1" height="1"/></g></defs></svg>`;
  assert.equal(flatten(normalizeStamp(bytes(ok))).length, 1);

  const conflict = `<svg ${H} ${XL}><use href="#a" xlink:href="#b"/><defs><g id="a"/><g id="b"/></defs></svg>`;
  assert.throws(() => validateStamp(bytes(conflict)), StampError);
  assert.throws(() => normalizeStamp(bytes(conflict)), StampError);

  const decoded = `<svg ${H} ${XL}><use href="#a" xlink:href="&#35;a"/><defs><g id="a"><rect width="1" height="1"/></g></defs></svg>`;
  assert.equal(flatten(normalizeStamp(bytes(decoded))).length, 1);
});

test("reachable cycles are rejected, unused cycles in defs are accepted", () => {
  const defs = `<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs>`;
  const reachable = `<svg ${H}><use href="#a"/>${defs}</svg>`;
  assert.throws(() => validateStamp(bytes(reachable)), /exceeds|cycle/i);
  assert.throws(() => normalizeStamp(bytes(reachable)), StampError);

  const unused = `<svg ${H}><rect width="1" height="1"/>${defs}</svg>`;
  const info = validateStamp(bytes(unused));
  assert.equal(info.nodes, 1);
  const svg = normalizeStamp(bytes(unused));
  assertClean(svg);
  assert.equal(flatten(svg).length, 1);
});

test("a legal 3000-level reference chain succeeds", () => {
  const depth = 3000;
  const parts: string[] = [];
  for (let i = 0; i < depth; i++) {
    const inner = i + 1 < depth ? `<use href="#g${i + 1}"/>` : `<rect width="1" height="1"/>`;
    parts.push(`<g id="g${i}">${inner}</g>`);
  }
  const src = `<svg ${H}><use href="#g0"/><defs>${parts.join("")}</defs></svg>`;
  const info = validateStamp(bytes(src));
  assert.equal(info.nodes, 1 + depth + (depth - 1) + 1);
  const svg = normalizeStamp(bytes(src));
  assertClean(svg);
  assert.equal(flatten(svg).length, 1);
});

test("exponential expansion is rejected in a controlled way", () => {
  const levels = 14; // 2^14 - 1 uses alone, far beyond the 10000 node budget
  const parts: string[] = [];
  for (let i = 0; i < levels; i++) {
    const inner = i + 1 < levels
      ? `<use href="#g${i + 1}"/><use href="#g${i + 1}"/>`
      : `<rect width="1" height="1"/>`;
    parts.push(`<g id="g${i}">${inner}</g>`);
  }
  const src = `<svg ${H}><use href="#g0"/><defs>${parts.join("")}</defs></svg>`;
  const start = Date.now();
  assert.throws(() => validateStamp(bytes(src)), StampError);
  assert.throws(() => normalizeStamp(bytes(src)), StampError);
  assert.ok(Date.now() - start < 5000, "rejection is fast");
});

test("validate and normalize agree on acceptance", () => {
  const XL = `xmlns:xlink="http://www.w3.org/1999/xlink"`;
  const cases: Array<[string, string, boolean]> = [
    ["minimal", `<svg ${H}/>`, true],
    ["bom", `\uFEFF<svg ${H}/>`, true],
    ["xml-decl", `<?xml version="1.0" encoding="UTF-8"?><svg ${H}/>`, true],
    ["comments", `<!-- a --><svg ${H}><!-- b --><rect width="1" height="1"/></svg><!-- c -->`, true],
    ["numeric-entity", `<svg ${H}><rect width="1" height="1" fill="&#35;ff0000"/></svg>`, true],
    ["predefined-entity", `<svg ${H}><g id="a&amp;b"/><use href="#a&amp;b"/></svg>`, true],
    ["dtd", `<!DOCTYPE svg><svg ${H}/>`, false],
    ["custom-entity", `<svg ${H}><rect width="1" height="1" fill="&foo;"/></svg>`, false],
    ["pi", `<svg ${H}><?xml-stylesheet href="x"?></svg>`, false],
    ["cdata", `<svg ${H}><![CDATA[x]]></svg>`, false],
    ["text-content", `<svg ${H}>hello</svg>`, false],
    ["dup-id", `<svg ${H}><g id="a"/><g id="a"/></svg>`, false],
    ["dangling-ref", `<svg ${H}><use href="#missing"/></svg>`, false],
    ["external-ref", `<svg ${H}><use href="https://evil.example/x.svg#a"/></svg>`, false],
    ["empty-fragment", `<svg ${H}><use href="#"/></svg>`, false],
    ["ref-to-root", `<svg ${H} id="root"><use href="#root"/></svg>`, false],
    ["ref-to-defs", `<svg ${H}><use href="#d"/><defs id="d"/>`, false],
    ["bad-fill", `<svg ${H}><rect width="1" height="1" fill="red"/></svg>`, false],
    ["short-hex", `<svg ${H}><rect width="1" height="1" fill="#fff"/></svg>`, false],
    ["fill-none", `<svg ${H}><rect width="1" height="1" fill="none"/></svg>`, true],
    ["missing-height", `<svg xmlns="${SVG_NS}" width="10"/>`, false],
    ["dim-too-big", `<svg xmlns="${SVG_NS}" width="4097" height="1"/>`, false],
    ["dim-px", `<svg xmlns="${SVG_NS}" width="10px" height="20px"/>`, true],
    ["dim-fractional", `<svg xmlns="${SVG_NS}" width="1.5" height="20"/>`, false],
    ["nested-svg", `<svg ${H}><svg width="1" height="1"/></svg>`, false],
    ["nested-defs", `<svg ${H}><g><defs/></g></svg>`, false],
    ["unknown-element", `<svg ${H}><line x1="0"/></svg>`, false],
    ["unknown-attr", `<svg ${H}><rect width="1" height="1" onclick="x()"/></svg>`, false],
    ["foreign-ns-attr", `<svg ${H} xmlns:e="http://example.com"><rect width="1" height="1" e:evil="1"/></svg>`, false],
    ["xlink-on-rect", `<svg ${H} ${XL}><rect width="1" height="1" xlink:href="#a"/></svg>`, false],
    ["leaf-children", `<svg ${H}><rect width="1" height="1"><g/></rect></svg>`, false],
    ["use-without-href", `<svg ${H}><use x="1"/></svg>`, false],
    ["undeclared-prefix", `<svg ${H}><q:g xmlns:q="${SVG_NS}"/><p:g/></svg>`, false],
    ["not-xml", `not xml at all`, false],
    ["empty", ``, false],
  ];
  for (const [name, src, ok] of cases) {
    const input = bytes(src);
    let validateOk = true;
    let normalizeOk = true;
    try {
      validateStamp(input);
    } catch (e) {
      validateOk = false;
      assert.ok(e instanceof StampError, `${name}: rejection uses StampError`);
    }
    try {
      normalizeStamp(input);
    } catch (e) {
      normalizeOk = false;
      assert.ok(e instanceof StampError, `${name}: rejection uses StampError`);
    }
    assert.equal(validateOk, ok, `${name}: validateStamp verdict`);
    assert.equal(normalizeOk, ok, `${name}: normalizeStamp verdict`);
  }
});

test("input larger than 512KiB is rejected", () => {
  const big = Buffer.alloc(512 * 1024 + 1, 0x20);
  assert.throws(() => validateStamp(big), StampError);
  assert.throws(() => normalizeStamp(big), StampError);
});

test("normalized output larger than 4MiB is rejected", () => {
  const d = "M0 0" + "h1".repeat(220_000); // ~440KB of path data
  const uses = Array.from({ length: 10 }, () => `<use href="#p"/>`).join("");
  const src = `<svg ${H}>${uses}<defs><path id="p" d="${d}"/></defs></svg>`;
  const input = bytes(src);
  assert.ok(input.length <= 512 * 1024, "input itself stays within limits");
  assert.throws(() => validateStamp(input), StampError);
  assert.throws(() => normalizeStamp(input), StampError);
});

test("invalid UTF-8 is rejected", () => {
  assert.throws(() => validateStamp(bytes(`<svg ${H}/>`).slice(0, 5)), StampError);
  assert.throws(() => validateStamp(Buffer.from([0xff, 0xfe, 0x00, 0x3c])), StampError);
});
