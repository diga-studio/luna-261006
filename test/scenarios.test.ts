import { test } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { matchLines } from '../src/match';
import { mergeDocuments } from '../src/merge';
import { resolveMerge } from '../src/resolve';
import type { MergeResult } from '../src/types';

function outline(result: MergeResult): Array<string | number> {
  const out: Array<string | number> = [];
  for (const segment of result.segments) {
    if (segment.type === 'lines') out.push(...segment.lines);
    else out.push(segment.conflictIndex);
  }
  return out;
}

test('场景一：大量重复行的小文档，多个最优匹配方案', () => {
  // 'a' 成段重复，无论插入还是删除一个 'a' 都有多个同样多的匹配方案
  const base = ['a', 'a', 'head', 'body', 'tail', 'a', 'a'];
  const local = ['a', 'a', 'a', 'head', 'local-body', 'tail', 'a', 'a'];
  const revised = ['a', 'head', 'revised-body', 'tail', 'a', 'a'];

  // 匹配行数最多（base 7 行中仅 body 被本地改掉，最多 6 对），
  // 平局时逐对比较，底稿行号小者优先、再相同则新版行号小者优先：
  // 因此插入的 'a' 落在所有已匹配 'a' 之后（点 2），而不是点 0 或点 1。
  deepStrictEqual(matchLines(base, local), [
    [0, 0],
    [1, 1],
    [2, 3],
    [4, 5],
    [5, 6],
    [6, 7],
  ]);
  // 最多 5 对；被删除的是底稿行号最大的那个 'a'（行 1 而不是行 0）。
  deepStrictEqual(matchLines(base, revised), [
    [0, 0],
    [2, 1],
    [4, 3],
    [5, 4],
    [6, 5],
  ]);

  const result = mergeDocuments(base, local, revised);
  // 两侧的 body 替换重叠，恰好一个冲突；删除与插入互不重叠，自动保留
  strictEqual(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  deepStrictEqual(conflict && conflict.baseStart, 3);
  deepStrictEqual(conflict && conflict.baseEnd, 4);
  deepStrictEqual(conflict && conflict.base, ['body']);
  deepStrictEqual(conflict && conflict.local, ['local-body']);
  deepStrictEqual(conflict && conflict.revised, ['revised-body']);
  deepStrictEqual(outline(result), ['a', 'a', 'head', 0, 'tail', 'a', 'a']);

  deepStrictEqual(resolveMerge(result, ['local']), [
    'a',
    'a',
    'head',
    'local-body',
    'tail',
    'a',
    'a',
  ]);
  deepStrictEqual(resolveMerge(result, ['revised']), [
    'a',
    'a',
    'head',
    'revised-body',
    'tail',
    'a',
    'a',
  ]);
});

test('场景二：一个替换跨越对方多处修改，另有边界插入', () => {
  const base = ['标题', '第一段', '第二段', '第三段', '第四段', '第五段', '结尾'];
  // 本地：把第一段到第五段整体重写
  const local = ['标题', '本地重写一', '本地重写二', '结尾'];
  // 修订：分别改第二段、第四段，并在本地替换范围的两个边界处插入
  const revised = [
    '标题',
    '修订插入-前',
    '第一段',
    '修订二',
    '第三段',
    '修订四',
    '第五段',
    '修订插入-后',
    '结尾',
  ];

  const result = mergeDocuments(base, local, revised);
  // 本地的整体替换与修订的两处修改重叠（可传递），只形成一个冲突
  strictEqual(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  deepStrictEqual(conflict && conflict.baseStart, 1);
  deepStrictEqual(conflict && conflict.baseEnd, 6);
  deepStrictEqual(conflict && conflict.base, [
    '第一段',
    '第二段',
    '第三段',
    '第四段',
    '第五段',
  ]);
  deepStrictEqual(conflict && conflict.local, ['本地重写一', '本地重写二']);
  // 修订侧片段中未改动的第一/三/五段不能遗漏
  deepStrictEqual(conflict && conflict.revised, [
    '第一段',
    '修订二',
    '第三段',
    '修订四',
    '第五段',
  ]);
  // 边界插入不属于冲突组，仍自动保留在冲突块两侧
  deepStrictEqual(outline(result), ['标题', '修订插入-前', 0, '修订插入-后', '结尾']);

  // 分别选取两侧，文档均不漏行、不重复行
  deepStrictEqual(resolveMerge(result, ['local']), [
    '标题',
    '修订插入-前',
    '本地重写一',
    '本地重写二',
    '修订插入-后',
    '结尾',
  ]);
  const resolvedRevised = resolveMerge(result, ['revised']);
  deepStrictEqual(resolvedRevised, [
    '标题',
    '修订插入-前',
    '第一段',
    '修订二',
    '第三段',
    '修订四',
    '第五段',
    '修订插入-后',
    '结尾',
  ]);
  // 选取修订侧后应恰好还原修订稿（本地的修改全部在冲突内）
  deepStrictEqual(resolvedRevised, revised);
});
