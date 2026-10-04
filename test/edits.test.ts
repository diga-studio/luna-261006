import { test } from 'node:test';
import { deepStrictEqual } from 'node:assert/strict';
import { computeEdits } from '../src/edits';
import { matchLines } from '../src/match';

function editsOf(base: string[], next: string[]) {
  return computeEdits(base, next, matchLines(base, next));
}

test('没有任何匹配时整篇视为一次替换', () => {
  deepStrictEqual(editsOf(['a', 'b'], ['x', 'y', 'z']), [
    { baseStart: 0, baseEnd: 2, lines: ['x', 'y', 'z'] },
  ]);
});

test('完全相同没有修改', () => {
  deepStrictEqual(editsOf(['a', 'b'], ['a', 'b']), []);
});

test('纯插入与纯删除', () => {
  deepStrictEqual(editsOf(['a', 'b'], ['a', 'x', 'y', 'b']), [
    { baseStart: 1, baseEnd: 1, lines: ['x', 'y'] },
  ]);
  deepStrictEqual(editsOf(['a', 'x', 'y', 'b'], ['a', 'b']), [
    { baseStart: 1, baseEnd: 3, lines: [] },
  ]);
});

test('首个匹配之前与末个匹配之后的差异', () => {
  deepStrictEqual(editsOf(['x', 'a', 'y'], ['p', 'a', 'q', 'r']), [
    { baseStart: 0, baseEnd: 1, lines: ['p'] },
    { baseStart: 2, baseEnd: 3, lines: ['q', 'r'] },
  ]);
});

test('相邻匹配之间的连续替换', () => {
  deepStrictEqual(editsOf(['a', 'x', 'y', 'b'], ['a', 'z', 'b']), [
    { baseStart: 1, baseEnd: 3, lines: ['z'] },
  ]);
});
