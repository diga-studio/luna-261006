import { test } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mergeDocuments } from '../src/merge';
import type { MergeResult } from '../src/types';

/** 把合并结果展开成行序列，冲突块用其序号占位，便于断言。 */
function outline(result: MergeResult): Array<string | number> {
  const out: Array<string | number> = [];
  for (const segment of result.segments) {
    if (segment.type === 'lines') out.push(...segment.lines);
    else out.push(segment.conflictIndex);
  }
  return out;
}

test('互不重叠的修改按原顺序保留', () => {
  const result = mergeDocuments(
    ['a', 'b', 'c', 'd'],
    ['a', 'L', 'c', 'd'],
    ['a', 'b', 'c', 'R'],
  );
  strictEqual(result.conflicts.length, 0);
  deepStrictEqual(outline(result), ['a', 'L', 'c', 'R']);
});

test('两侧相同的替换只保留一次', () => {
  const result = mergeDocuments(['a', 'b', 'c'], ['a', 'X', 'c'], ['a', 'X', 'c']);
  strictEqual(result.conflicts.length, 0);
  deepStrictEqual(outline(result), ['a', 'X', 'c']);
});

test('同一位置的相同插入只保留一次', () => {
  const result = mergeDocuments(['a', 'b'], ['a', 'X', 'b'], ['a', 'X', 'b']);
  strictEqual(result.conflicts.length, 0);
  deepStrictEqual(outline(result), ['a', 'X', 'b']);
});

test('首尾相接的替换不算重叠', () => {
  const result = mergeDocuments(['a', 'b', 'c'], ['L', 'b', 'c'], ['a', 'R', 'c']);
  strictEqual(result.conflicts.length, 0);
  deepStrictEqual(outline(result), ['L', 'R', 'c']);
});

test('替换起点处的插入排在替换内容之前且不冲突', () => {
  const result = mergeDocuments(['a', 'b', 'c', 'd'], ['a', 'L', 'd'], ['a', 'R', 'b', 'c', 'd']);
  strictEqual(result.conflicts.length, 0);
  deepStrictEqual(outline(result), ['a', 'R', 'L', 'd']);
});

test('替换终点处的插入排在替换内容之后且不冲突', () => {
  const result = mergeDocuments(['a', 'b', 'c', 'd'], ['a', 'L', 'd'], ['a', 'b', 'c', 'R', 'd']);
  strictEqual(result.conflicts.length, 0);
  deepStrictEqual(outline(result), ['a', 'L', 'R', 'd']);
});

test('同一位置的不同插入形成冲突', () => {
  const result = mergeDocuments(['a', 'b'], ['a', 'L', 'b'], ['a', 'R', 'b']);
  strictEqual(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  deepStrictEqual(conflict && conflict.base, []);
  deepStrictEqual(conflict && conflict.local, ['L']);
  deepStrictEqual(conflict && conflict.revised, ['R']);
  deepStrictEqual(outline(result), ['a', 0, 'b']);
});

test('插入点严格位于替换范围内部才算重叠', () => {
  const result = mergeDocuments(
    ['a', 'b', 'c', 'd'],
    ['a', 'L', 'd'],
    ['a', 'b', 'R', 'c', 'd'],
  );
  strictEqual(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  deepStrictEqual(conflict && conflict.base, ['b', 'c']);
  deepStrictEqual(conflict && conflict.local, ['L']);
  deepStrictEqual(conflict && conflict.revised, ['b', 'R', 'c']);
});

test('重叠关系可传递，连成一组只产生一个冲突', () => {
  const result = mergeDocuments(
    ['a', 'b', 'c', 'd', 'e'],
    ['a', 'L', 'e'],
    ['a', 'R1', 'c', 'R2', 'e'],
  );
  strictEqual(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  deepStrictEqual(conflict && conflict.baseStart, 1);
  deepStrictEqual(conflict && conflict.baseEnd, 4);
  deepStrictEqual(conflict && conflict.base, ['b', 'c', 'd']);
  deepStrictEqual(conflict && conflict.local, ['L']);
  // 修订侧片段中未改动的 c 不能遗漏
  deepStrictEqual(conflict && conflict.revised, ['R1', 'c', 'R2']);
  deepStrictEqual(outline(result), ['a', 0, 'e']);
});

test('整篇替换与另一侧的内部插入形成冲突', () => {
  const result = mergeDocuments(['a', 'b'], ['x'], ['a', 'R', 'b']);
  strictEqual(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  deepStrictEqual(conflict && conflict.base, ['a', 'b']);
  deepStrictEqual(conflict && conflict.local, ['x']);
  deepStrictEqual(conflict && conflict.revised, ['a', 'R', 'b']);
});

test('整篇替换边界处的插入仍自动保留', () => {
  const result = mergeDocuments(['a', 'b'], ['x'], ['a', 'b', 'c']);
  strictEqual(result.conflicts.length, 0);
  deepStrictEqual(outline(result), ['x', 'c']);
});

test('相同输入得到相同的合并内容、冲突范围及顺序', () => {
  const base = ['a', 'b', 'c', 'd', 'e', 'f'];
  const local = ['a', 'L1', 'c', 'L2', 'e', 'f'];
  const revised = ['a', 'R1', 'c', 'd', 'R2', 'f'];
  const first = mergeDocuments(base, local, revised);
  const second = mergeDocuments(base, local, revised);
  deepStrictEqual(first, second);
});
