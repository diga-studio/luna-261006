import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, SubsetError } from '../src/index.js';

const rejected: Array<[string, string]> = [
  ['missing open tag', `define('A', true);`],
  ['closing tag', `<?php define('A', true); ?>`],
  ['variable assignment', `<?php $x = true;`],
  ['variable in condition', `<?php if ($x) { define('A', true); }`],
  ['double-quoted string', `<?php define("A", true);`],
  ['numeric literal', `<?php define('A', 1);`],
  ['echo statement', `<?php echo 'hi';`],
  ['while loop', `<?php while (true) { define('A', true); }`],
  ['foreach loop', `<?php foreach ($a as $b) { define('A', true); }`],
  ['function declaration', `<?php function f() { return true; }`],
  ['return statement', `<?php return true;`],
  ['include', `<?php include 'wp-settings.php';`],
  ['require', `<?php require 'wp-settings.php';`],
  ['arbitrary function call', `<?php phpinfo();`],
  ['unknown constant in expression', `<?php define('A', SOME_CONST);`],
  ['loose equality', `<?php if (getenv('K') == '1') { define('A', true); }`],
  ['not-identical operator', `<?php if (getenv('K') !== '1') { define('A', true); }`],
  ['wrong comparison literal', `<?php if (getenv('K') === 'yes') { define('A', true); }`],
  ['assignment operator', `<?php if (getenv('K') = '1') { define('A', true); }`],
  ['unbraced if body', `<?php if (true) define('A', true);`],
  ['unbraced else body', `<?php if (true) { define('A', true); } else define('A', false);`],
  ['unterminated block comment', `<?php /* never ends`],
  ['unterminated string', `<?php define('A, true);`],
  ['unterminated brace', `<?php if (true) { define('A', true);`],
  ['array syntax', `<?php define('A', array());`],
  ['ternary', `<?php define('A', true ? true : false);`],
  ['null literal', `<?php define('A', null);`],
  ['heredoc-ish text', `<?php <<<EOT\nhello\nEOT;`],
];

for (const [name, source] of rejected) {
  test(`rejects: ${name}`, () => {
    assert.throws(() => parse(source), SubsetError);
  });
}

test('accepts empty program and bare semicolons', () => {
  assert.deepEqual(parse('<?php'), { stmts: [] });
  assert.deepEqual(parse('<?php ; ; ;'), { stmts: [] });
});

test('accepts all comment styles without being fooled by directives inside', () => {
  const source = `<?php
// define('A', false);
# define('B', false);
/* define('C', false); */
/** docblock define('D', false); */
define('E', true); // trailing
`;
  const program = parse(source);
  assert.equal(program.stmts.length, 1);
  assert.deepEqual(program.stmts[0], {
    kind: 'define',
    name: 'E',
    value: { kind: 'const', value: true },
  });
});

test('string escapes: backslash and quote only', () => {
  const program = parse(`<?php define('it\\\\' . '\\\\' . 'don\\'t', true);`);
  const stmt = program.stmts[0]!;
  assert.equal(stmt.kind, 'define');
  // 'it\\' -> it\  ;  '\\' -> \  ;  'don\'t' -> don't
  assert.equal(stmt.name, `it\\\\don't`);
});

test('precedence: ! binds tighter than &&, && tighter than ||', () => {
  const program = parse(`<?php define('A', !true || false && true);`);
  const stmt = program.stmts[0]!;
  assert.equal(stmt.kind, 'define');
  if (stmt.kind !== 'define') return;
  // Parses as (!true) || (false && true)
  assert.equal(stmt.value.kind, 'or');
  if (stmt.value.kind !== 'or') return;
  assert.equal(stmt.value.left.kind, 'not');
  assert.equal(stmt.value.right.kind, 'and');
});

test('parenthesized nested expression', () => {
  const program = parse(`<?php define('A', ((true)));`);
  const stmt = program.stmts[0]!;
  assert.deepEqual(stmt, { kind: 'define', name: 'A', value: { kind: 'const', value: true } });
});

test('getenv comparison with concatenated key', () => {
  const program = parse(`<?php if (getenv('WP_' . 'ENV') === '1') { define('A', true); }`);
  const stmt = program.stmts[0]!;
  assert.equal(stmt.kind, 'if');
  if (stmt.kind !== 'if') return;
  assert.deepEqual(stmt.cond, { kind: 'env', key: 'WP_ENV' });
});
