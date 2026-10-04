import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { analyze, evaluate } from '../src/index.js';

test('CONDITIONAL: env-guarded false then unconditional true, decoy defines in comments', () => {
  const source = `<?php
// define('DISALLOW_FILE_EDIT', true);
/* define('FORCE_SSL_ADMIN', true);
   if (getenv('ALLOW_EDIT') === '1') { define('DISALLOW_FILE_EDIT', true); } */
# define('DISALLOW_FILE_EDIT', true);
if (getenv('ALLOW_EDIT') === '1') {
  define('DISALLOW_FILE_EDIT', false);
}
define('DISALLOW_FILE_EDIT', true);
define('FORCE_SSL_ADMIN', true);
`;
  const result = analyze(source);
  assert.equal(result.result, 'CONDITIONAL');
  // Both witnesses exist, cover every referenced env key, and re-verify
  // through evaluate.
  assert.deepEqual(Object.keys(result.compliantWitness!).sort(), ['ALLOW_EDIT']);
  assert.deepEqual(Object.keys(result.nonCompliantWitness!).sort(), ['ALLOW_EDIT']);
  assert.equal(evaluate(source, result.compliantWitness!).compliant, true);
  assert.equal(evaluate(source, result.nonCompliantWitness!).compliant, false);
  // The non-compliant branch really is the env-true one.
  assert.equal(evaluate(source, { ALLOW_EDIT: true }).compliant, false);
  assert.equal(evaluate(source, { ALLOW_EDIT: true }).values.DISALLOW_FILE_EDIT, false);
  assert.equal(evaluate(source, { ALLOW_EDIT: false }).compliant, true);
});

test('PASS: 60 env keys, conjunction of defined() vs its De Morgan dual', () => {
  const keys = Array.from({ length: 60 }, (_, i) => `KEY_${String(i + 1).padStart(2, '0')}`);
  const aux = (i: number) => `AUX_${String(i + 1).padStart(2, '0')}`;
  const lines: string[] = ['<?php'];
  keys.forEach((k, i) => {
    lines.push(`if (getenv('${k}') === '1') { define('${aux(i)}', true); }`);
  });
  const conj = keys.map((_, i) => `defined('${aux(i)}')`).join(' && ');
  lines.push(`if (${conj}) {`);
  lines.push(`  define('DISALLOW_FILE_EDIT', true);`);
  lines.push(`  define('FORCE_SSL_ADMIN', true);`);
  lines.push(`}`);
  // Same coverage condition written as the De Morgan dual, in reverse order.
  const dual = keys.map((_, i) => `!defined('${aux(keys.length - 1 - i)}')`).join(' || ');
  lines.push(`if (${dual}) {`);
  lines.push(`  define('DISALLOW_FILE_EDIT', true);`);
  lines.push(`  define('FORCE_SSL_ADMIN', true);`);
  lines.push(`}`);
  const source = lines.join('\n');

  const start = performance.now();
  const result = analyze(source);
  const elapsed = performance.now() - start;
  assert.equal(result.result, 'PASS');
  assert.ok(elapsed < 5000, `took ${elapsed.toFixed(0)}ms`);
  // Witness covers all 60 keys and re-verifies through evaluate.
  assert.deepEqual(Object.keys(result.compliantWitness!).sort(), [...keys].sort());
  assert.equal(evaluate(source, result.compliantWitness!).compliant, true);
});

test('PASS without any environment keys', () => {
  const source = `<?php
define('DISALLOW_FILE_EDIT', true);
define('FORCE_SSL_ADMIN', true);
`;
  const result = analyze(source);
  assert.equal(result.result, 'PASS');
  assert.deepEqual(result.compliantWitness, {});
  assert.equal(result.nonCompliantWitness, undefined);
});

test('FAIL: targets never both true', () => {
  const source = `<?php
define('DISALLOW_FILE_EDIT', true);
`;
  const result = analyze(source);
  assert.equal(result.result, 'FAIL');
  assert.equal(result.compliantWitness, undefined);
  assert.equal(evaluate(source, result.nonCompliantWitness!).compliant, false);
});

test('FAIL: first define wins, later true define cannot fix a false', () => {
  const source = `<?php
define('DISALLOW_FILE_EDIT', false);
define('DISALLOW_FILE_EDIT', true);
define('FORCE_SSL_ADMIN', true);
`;
  assert.equal(analyze(source).result, 'FAIL');
  const out = evaluate(source, {});
  assert.equal(out.values.DISALLOW_FILE_EDIT, false);
  assert.equal(out.compliant, false);
});

test('defined() is about definedness, not truthiness', () => {
  const source = `<?php
define('HELPER', false);
if (defined('HELPER')) {
  define('DISALLOW_FILE_EDIT', true);
  define('FORCE_SSL_ADMIN', true);
}
`;
  assert.equal(analyze(source).result, 'PASS');
});

test('constant names are case-sensitive', () => {
  const source = `<?php
define('disallow_file_edit', true);
define('FORCE_SSL_ADMIN', true);
`;
  assert.equal(analyze(source).result, 'FAIL');
});

test('dot-concatenated constant names and env keys', () => {
  const source = `<?php
if (getenv('SS' . 'L_ON') === '1') {
  define('DISALLOW_' . 'FILE' . '_EDIT', true);
  define('FORCE_SSL_' . 'ADMIN', true);
} else {
  define('DISALLOW_FILE_EDIT', true);
  define('FORCE_SSL_ADMIN', true);
}
`;
  const result = analyze(source);
  assert.equal(result.result, 'PASS');
  assert.deepEqual(Object.keys(result.compliantWitness!), ['SSL_ON']);
});

test('branches depending on env can still agree on a safe outcome', () => {
  const source = `<?php
if (getenv('A') === '1') {
  if (getenv('B') === '1') {
    define('DISALLOW_FILE_EDIT', true);
  } else {
    define('DISALLOW_FILE_EDIT', true);
  }
} else {
  define('DISALLOW_FILE_EDIT', true);
}
define('FORCE_SSL_ADMIN', true);
`;
  assert.equal(analyze(source).result, 'PASS');
});

test('repeated env checks stay correlated', () => {
  // If the two reads of K were treated as independent, this would look
  // CONDITIONAL; correlation makes it PASS.
  const source = `<?php
if (getenv('K') === '1') {
  define('DISALLOW_FILE_EDIT', true);
}
if (!(getenv('K') === '1')) {
  define('DISALLOW_FILE_EDIT', true);
}
define('FORCE_SSL_ADMIN', true);
`;
  assert.equal(analyze(source).result, 'PASS');
});
