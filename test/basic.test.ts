import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, evaluate } from "../src/index.js";

test("conditional: env-gated false define followed by unconditional true define", () => {
  const source = `<?php
// define('DISALLOW_FILE_EDIT', true);  -- pseudo directive inside a comment
/* define('FORCE_SSL_ADMIN', true); */
if (getenv('LEGACY_MODE') === '1') {
  define('DISALLOW_FILE_EDIT', false);
}
define('DISALLOW_FILE_EDIT', true);
define('FORCE_SSL_ADMIN', true);
`;
  const result = analyze(source);
  assert.equal(result.verdict, "CONDITIONAL");
  const compliantWitness = result.compliantWitness;
  const nonCompliantWitness = result.nonCompliantWitness;
  assert.ok(compliantWitness, "needs a compliant witness");
  assert.ok(nonCompliantWitness, "needs a non-compliant witness");

  // Witnesses must mention every env key referenced by the source.
  assert.deepEqual(Object.keys(compliantWitness.env).sort(), ["LEGACY_MODE"]);
  assert.deepEqual(Object.keys(nonCompliantWitness.env).sort(), ["LEGACY_MODE"]);

  // Re-verify both witnesses with the concrete evaluator.
  assert.equal(evaluate(source, compliantWitness.env).compliant, true);
  assert.equal(evaluate(source, nonCompliantWitness.env).compliant, false);
});

test("evaluate distinguishes undefined from false", () => {
  const source = `<?php
define('DISALLOW_FILE_EDIT', false);
`;
  const result = evaluate(source, {});
  assert.deepEqual(result.constants.DISALLOW_FILE_EDIT, { defined: true, value: false });
  assert.deepEqual(result.constants.FORCE_SSL_ADMIN, { defined: false, value: false });
  assert.equal(result.compliant, false);
});

test("first define wins on the same path", () => {
  const source = `<?php
define('DISALLOW_FILE_EDIT', false);
define('DISALLOW_FILE_EDIT', true);
define('FORCE_SSL_ADMIN', true);
`;
  const result = evaluate(source, {});
  assert.equal(result.constants.DISALLOW_FILE_EDIT.value, false);
  assert.equal(result.compliant, false);
});

test("defined() is about existence, not truthiness", () => {
  const source = `<?php
define('HELPER', false);
if (defined('HELPER')) {
  define('DISALLOW_FILE_EDIT', true);
  define('FORCE_SSL_ADMIN', true);
}
`;
  assert.equal(analyze(source).verdict, "PASS");
});

test("constant names are case sensitive", () => {
  const source = `<?php
define('disallow_file_edit', true);
define('FORCE_SSL_ADMIN', true);
`;
  assert.equal(analyze(source).verdict, "FAIL");
});

test("conditions read the constant state at their execution point", () => {
  const source = `<?php
if (defined('LATE')) {
  define('DISALLOW_FILE_EDIT', false);
}
define('LATE', true);
if (defined('LATE')) {
  define('DISALLOW_FILE_EDIT', true);
  define('FORCE_SSL_ADMIN', true);
}
`;
  assert.equal(analyze(source).verdict, "PASS");
});

test("same env key stays correlated across checks", () => {
  // If the two getenv('K') checks were independent, both branches could
  // look reachable and this would be CONDITIONAL; correlated, the else
  // branch always defines the constants, so it is PASS.
  const source = `<?php
if (getenv('K') === '1') {
  define('DISALLOW_FILE_EDIT', true);
  define('FORCE_SSL_ADMIN', true);
} else {
  define('DISALLOW_FILE_EDIT', true);
  define('FORCE_SSL_ADMIN', true);
}
`;
  assert.equal(analyze(source).verdict, "PASS");
});

test("different branches guaranteeing the same safe result give PASS", () => {
  const source = `<?php
if (getenv('A') === '1') {
  define('DISALLOW_FILE_EDIT', true);
} else {
  define('DISALLOW_FILE_EDIT', true);
}
if (getenv('B') === '1' || !(getenv('B') === '1')) {
  define('FORCE_SSL_ADMIN', true);
}
`;
  assert.equal(analyze(source).verdict, "PASS");
});

test("string concatenation in names and keys", () => {
  const source = `<?php
if (getenv('A' . 'B') === '1') {
  define('DISALLOW_' . 'FILE_EDIT', true);
  define('FORCE_SSL_ADMIN', true);
} else {
  define('DISALLOW_FILE_EDIT', true);
  define('FORCE_SSL_ADMIN', true);
}
`;
  const result = analyze(source);
  assert.equal(result.verdict, "PASS");
});

test("out-of-subset syntax is rejected", () => {
  const bad = [
    "<?php $x = 1;",
    "<?php define('A', true); ?>",
    "<?php while (true) {}",
    "<?php function f() {}",
    "<?php require 'x.php';",
    "<?php define('A', 1);",
    "<?php define('A', true)",
    "<?php if (true) define('A', true);", // braces required
    "<?php echo 'x';",
    "define('A', true);", // missing open tag
    "<?php define(\"A\", true);", // double quotes unsupported
    "<?php if (getenv('K') === 'yes') { define('A', true); }",
    "<?php if (getenv('K') !== '1') { define('A', true); }",
  ];
  for (const source of bad) {
    assert.throws(() => analyze(source), undefined, source);
  }
});

test("empty statements and nested if/else", () => {
  const source = `<?php
;;
if (true) {
  ;
  if (getenv('X') === '1') {
    define('A', true);
  } else {
    define('A', true);
  }
}
if (defined('A')) {
  define('DISALLOW_FILE_EDIT', true);
  define('FORCE_SSL_ADMIN', true);
}
`;
  assert.equal(analyze(source).verdict, "PASS");
});
