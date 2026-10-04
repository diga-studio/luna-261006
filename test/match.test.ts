import { test } from 'node:test';
import { deepStrictEqual } from 'node:assert/strict';
import { matchLines } from '../src/match';

test('空文档与全等不同', () => {
  deepStrictEqual(matchLines([], []), []);
  deepStrictEqual(matchLines(['a'], ['b']), []);
  deepStrictEqual(matchLines([], ['a']), []);
  deepStrictEqual(matchLines(['a'], []), []);
});

test('完全相等时全部匹配', () => {
  deepStrictEqual(matchLines(['a', 'b'], ['a', 'b']), [
    [0, 0],
    [1, 1],
  ]);
});

test('平局时底稿行号小者优先', () => {
  // LCS 长度为 1，可选 (0,1) 或 (1,0)，底稿行号 0 优先
  deepStrictEqual(matchLines(['a', 'b'], ['b', 'a']), [[0, 1]]);
});

test('底稿行号相同则新版行号小者优先', () => {
  deepStrictEqual(matchLines(['a'], ['a', 'a']), [[0, 0]]);
  deepStrictEqual(matchLines(['a', 'a'], ['a']), [[0, 0]]);
});

test('多对匹配依次按行号优先', () => {
  // LCS 长度为 2，可选 [(1,0),(2,1)] 或 [(0,1),(1,2)]，首对底稿行号 0 优先
  deepStrictEqual(matchLines(['x', 'a', 'x'], ['a', 'x', 'a']), [
    [0, 1],
    [1, 2],
  ]);
});

test('重复行插入：多个最优方案中取行号最小者', () => {
  // 三个 'a' 对两个 'a'，LCS 为 2，最优方案有多种
  deepStrictEqual(matchLines(['a', 'a'], ['a', 'a', 'a']), [
    [0, 0],
    [1, 1],
  ]);
  deepStrictEqual(matchLines(['a', 'a', 'a'], ['a', 'a']), [
    [0, 0],
    [1, 1],
  ]);
});

test('空白与空行参与匹配且不可忽略', () => {
  deepStrictEqual(matchLines(['', ' a', ''], ['', 'a', '']), [
    [0, 0],
    [2, 2],
  ]);
});
