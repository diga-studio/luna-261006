import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyMp4 } from '../src/index.js';

test('骨架：verifyMp4 可导入', () => {
  assert.equal(typeof verifyMp4, 'function');
});
