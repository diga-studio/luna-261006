import { test } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { mergeDocuments } from '../src/merge';
import { resolveMerge } from '../src/resolve';
import type { Side } from '../src/types';

test('无冲突时直接得到自动合并结果', () => {
  const result = mergeDocuments(['a', 'b'], ['a', 'L', 'b'], ['a', 'b', 'R']);
  strictEqual(result.conflicts.length, 0);
  deepStrictEqual(resolveMerge(result, []), ['a', 'L', 'b', 'R']);
});

test('每个冲突分别选择本地侧或修订侧', () => {
  const result = mergeDocuments(
    ['a', 'b', 'c', 'd'],
    ['a', 'L1', 'c', 'L2'],
    ['a', 'R1', 'c', 'R2'],
  );
  strictEqual(result.conflicts.length, 2);
  deepStrictEqual(resolveMerge(result, ['local', 'local']), ['a', 'L1', 'c', 'L2']);
  deepStrictEqual(resolveMerge(result, ['revised', 'revised']), ['a', 'R1', 'c', 'R2']);
  deepStrictEqual(resolveMerge(result, ['local', 'revised']), ['a', 'L1', 'c', 'R2']);
  deepStrictEqual(resolveMerge(result, ['revised', 'local']), ['a', 'R1', 'c', 'L2']);
});

test('选择数量与冲突数量不一致时报错', () => {
  const result = mergeDocuments(['a'], ['L'], ['R']);
  strictEqual(result.conflicts.length, 1);
  throws(() => resolveMerge(result, []));
  throws(() => resolveMerge(result, ['local', 'local']));
});

test('选择值非法时报错，不默默偏向某一侧', () => {
  const result = mergeDocuments(['a'], ['L'], ['R']);
  throws(() => resolveMerge(result, ['base' as Side]));
});

test('最终文档只替换被选择的冲突片段，自动合并内容原样保留', () => {
  const result = mergeDocuments(
    ['h', 'a', 'b', 't'],
    ['h', 'L', 't', 'local-tail'],
    ['h', 'R', 't'],
  );
  strictEqual(result.conflicts.length, 1);
  deepStrictEqual(resolveMerge(result, ['local']), ['h', 'L', 't', 'local-tail']);
  deepStrictEqual(resolveMerge(result, ['revised']), ['h', 'R', 't', 'local-tail']);
});
