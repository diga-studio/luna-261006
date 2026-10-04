import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, SubsetError } from '../src/index.js';

test('undefined is distinguished from false', () => {
  const source = `<?php
define('DISALLOW_FILE_EDIT', false);
`;
  const out = evaluate(source, {});
  assert.equal(out.values.DISALLOW_FILE_EDIT, false);
  assert.equal(out.values.FORCE_SSL_ADMIN, undefined);
  assert.equal(out.compliant, false);
});

test('empty program leaves both targets undefined', () => {
  const out = evaluate('<?php', {});
  assert.equal(out.values.DISALLOW_FILE_EDIT, undefined);
  assert.equal(out.values.FORCE_SSL_ADMIN, undefined);
  assert.equal(out.compliant, false);
});

test('env values drive getenv checks; missing key is an error', () => {
  const source = `<?php
if (getenv('K') === '1') {
  define('DISALLOW_FILE_EDIT', true);
  define('FORCE_SSL_ADMIN', true);
}
`;
  assert.equal(evaluate(source, { K: true }).compliant, true);
  assert.equal(evaluate(source, { K: false }).compliant, false);
  assert.throws(() => evaluate(source, {}), SubsetError);
});

test('condition reads constant state at its position, not later defines', () => {
  const source = `<?php
if (!defined('LATER')) {
  define('DISALLOW_FILE_EDIT', true);
}
define('LATER', true);
if (defined('LATER')) {
  define('FORCE_SSL_ADMIN', true);
}
`;
  const out = evaluate(source, {});
  assert.equal(out.compliant, true);
});

test('nested if/else with helper constants and redefinition', () => {
  const source = `<?php
if (getenv('A') === '1') {
  define('H', true);
} else {
  define('H', false);
}
if (defined('H') && getenv('B') === '1') {
  define('DISALLOW_FILE_EDIT', true);
  define('DISALLOW_FILE_EDIT', false);
}
if (defined('H') && getenv('B') === '1') {
  define('FORCE_SSL_ADMIN', true);
}
`;
  const yes = evaluate(source, { A: false, B: true });
  assert.equal(yes.compliant, true);
  const no = evaluate(source, { A: true, B: false });
  assert.equal(no.values.DISALLOW_FILE_EDIT, undefined);
  assert.equal(no.compliant, false);
});
