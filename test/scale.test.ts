import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, evaluate } from "../src/index.js";

test("60 env keys with De Morgan dual coverage yields PASS within 5s", () => {
  const n = 60;
  const keys = Array.from({ length: n }, (_, i) => `K${i}`);
  const helpers = Array.from({ length: n }, (_, i) => `H${i}`);

  const lines: string[] = ["<?php"];
  // Each helper is conditionally defined by an independent env check.
  for (let i = 0; i < n; i++) {
    lines.push(`if (getenv('${keys[i]}') === '1') {`);
    lines.push(`  define('${helpers[i]}', true);`);
    lines.push(`}`);
  }
  // C = conjunction of defined(H_i), in forward order.
  const conj = helpers.map((h) => `defined('${h}')`).join(" && ");
  lines.push(`if (${conj}) {`);
  lines.push(`  define('DISALLOW_FILE_EDIT', true);`);
  lines.push(`  define('FORCE_SSL_ADMIN', true);`);
  lines.push(`}`);
  // De Morgan negation of C, written in reverse order:
  // !C === !defined(H_n) || ... || !defined(H_0)
  const neg = [...helpers]
    .reverse()
    .map((h) => `!defined('${h}')`)
    .join(" || ");
  lines.push(`if (${neg}) {`);
  lines.push(`  define('DISALLOW_FILE_EDIT', true);`);
  lines.push(`  define('FORCE_SSL_ADMIN', true);`);
  lines.push(`}`);
  const source = lines.join("\n");

  const start = performance.now();
  const result = analyze(source);
  const elapsedMs = performance.now() - start;

  assert.equal(result.verdict, "PASS");
  assert.ok(elapsedMs < 5000, `took ${elapsedMs.toFixed(0)}ms, limit is 5000ms`);

  // Sanity: the witness must be compliant under concrete evaluation.
  const witness = result.compliantWitness;
  assert.ok(witness);
  assert.equal(Object.keys(witness.env).length, n);
  assert.equal(evaluate(source, witness.env).compliant, true);
});

test("5000 statements over 64 env keys complete quickly", () => {
  const lines: string[] = ["<?php"];
  for (let i = 0; i < 5000; i++) {
    const key = `E${i % 64}`;
    if (i % 3 === 0) {
      lines.push(`if (getenv('${key}') === '1') { define('A${i % 97}', true); }`);
    } else if (i % 3 === 1) {
      lines.push(`define('A${i % 97}', defined('A${(i + 1) % 97}'));`);
    } else {
      lines.push(`if (!defined('A${i % 97}')) { define('A${i % 97}', false); } else { ; }`);
    }
  }
  lines.push("define('DISALLOW_FILE_EDIT', true);");
  lines.push("define('FORCE_SSL_ADMIN', true);");
  const source = lines.join("\n");

  const start = performance.now();
  const result = analyze(source);
  const elapsedMs = performance.now() - start;

  assert.equal(result.verdict, "PASS");
  assert.ok(elapsedMs < 5000, `took ${elapsedMs.toFixed(0)}ms`);
});
