import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { analyze, evaluate } from '../src/index.js';

test('scales to 64 env keys and ~5000 statements', () => {
  const keys = Array.from({ length: 64 }, (_, i) => `SCALE_KEY_${i}`);
  const lines: string[] = ['<?php'];
  // ~1600 conditional defines over 64 keys, plus plain defines: ~5000 stmts.
  for (let round = 0; round < 25; round += 1) {
    for (let k = 0; k < 64; k += 1) {
      lines.push(
        `if (getenv('${keys[k]}') === '1') { define('H_${round}_${k}', defined('H_${round}_${(k + 1) % 64}')); }`,
      );
    }
  }
  for (let i = 0; i < 3400; i += 1) {
    lines.push(`define('PAD_${i}', defined('PAD_${i}'));`);
  }
  lines.push(`define('DISALLOW_FILE_EDIT', true);`);
  lines.push(`define('FORCE_SSL_ADMIN', true);`);
  const source = lines.join('\n');

  const start = performance.now();
  const result = analyze(source);
  const elapsed = performance.now() - start;
  assert.equal(result.result, 'PASS');
  assert.ok(elapsed < 5000, `took ${elapsed.toFixed(0)}ms`);
  assert.equal(Object.keys(result.compliantWitness!).length, 64);

  const env: Record<string, boolean> = {};
  for (const key of keys) env[key] = true;
  assert.equal(evaluate(source, env).compliant, true);
});
