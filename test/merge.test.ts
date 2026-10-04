import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchLines, computeEdits } from '../src/diff';
import { merge, resolve } from '../src/merge';
import type { MergeResult } from '../src/types';

/** 展开合并结果中所有自动保留的行（跳过冲突块），便于断言。 */
function autoLines(result: MergeResult): string[] {
  const out: string[] = [];
  for (const chunk of result.chunks) {
    if (chunk.kind === 'lines') out.push(...chunk.lines);
  }
  return out;
}

test('重复行：匹配数最多，平局时底稿行号优先、再新版行号优先', () => {
  // 三个相同行对两个相同行：最大匹配 2 对，取最早的行号。
  assert.deepEqual(matchLines(['a', 'a', 'a'], ['a', 'a']), [
    { baseIndex: 0, sideIndex: 0 },
    { baseIndex: 1, sideIndex: 1 },
  ]);
  // 反向：两个相同行对三个相同行。
  assert.deepEqual(matchLines(['a', 'a'], ['a', 'a', 'a']), [
    { baseIndex: 0, sideIndex: 0 },
    { baseIndex: 1, sideIndex: 1 },
  ]);
  // 多个最优方案：第一对必须取底稿行号 0（而非跳过它）。
  assert.deepEqual(matchLines(['b', 'x', 'a'], ['x', 'b', 'a']), [
    { baseIndex: 0, sideIndex: 1 },
    { baseIndex: 2, sideIndex: 2 },
  ]);
  // 底稿行号相同再比新版行号：取 (0,1) 而非 (0,2)。
  assert.deepEqual(matchLines(['x', 'a'], ['a', 'x', 'x']), [
    { baseIndex: 0, sideIndex: 1 },
  ]);
  // 大量重复行：5 个相同行对 3 个相同行，匹配前 3 对。
  const matches = matchLines(['x', 'x', 'x', 'x', 'x'], ['x', 'x', 'x']);
  assert.equal(matches.length, 3);
  assert.deepEqual(matches, [
    { baseIndex: 0, sideIndex: 0 },
    { baseIndex: 1, sideIndex: 1 },
    { baseIndex: 2, sideIndex: 2 },
  ]);
  // 对应的编辑是纯删除末尾两行。
  assert.deepEqual(computeEdits(['x', 'x', 'x', 'x', 'x'], ['x', 'x', 'x'], matches), [
    { baseStart: 3, baseEnd: 5, lines: [] },
  ]);
});

test('无匹配时整篇视为一次替换', () => {
  const edits = computeEdits(['a', 'b'], ['c'], []);
  assert.deepEqual(edits, [{ baseStart: 0, baseEnd: 2, lines: ['c'] }]);
  const result = merge(['a', 'b'], ['c'], ['d']);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0], {
    baseStart: 0,
    baseEnd: 2,
    baseLines: ['a', 'b'],
    localLines: ['c'],
    remoteLines: ['d'],
  });
});

test('重复行文档：匹配平局影响编辑边界，重叠修改形成冲突', () => {
  const base = ['h', 'x', 'x', 'x', 't'];
  // 本地：中间夹一行 L。按平局规则，x 行锚定最早位置，
  // 得到“在 2 处插入 L”与“删除底稿第 3 行”两次修改。
  const local = ['h', 'x', 'L', 'x', 't'];
  // 修订：把底稿第 3 行改为 R。
  const remote = ['h', 'x', 'x', 'R', 't'];
  const result = merge(base, local, remote);
  // 本地的插入不与任何修改重叠，自动保留；
  // 本地删除第 3 行与修订替换第 3 行重叠，形成一个冲突。
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0], {
    baseStart: 3,
    baseEnd: 4,
    baseLines: ['x'],
    localLines: [],
    remoteLines: ['R'],
  });
  assert.deepEqual(autoLines(result), ['h', 'x', 'L', 'x', 't']);
  assert.deepEqual(resolve(result, ['local']), ['h', 'x', 'L', 'x', 't']);
  assert.deepEqual(resolve(result, ['remote']), ['h', 'x', 'L', 'x', 'R', 't']);
});

test('两侧完全相同的修改只保留一次', () => {
  const base = ['h', 'x', 'x', 't'];
  const local = ['h', 'new', 'x', 'y', 't'];
  const remote = ['h', 'new', 'x', 'y', 't'];
  const result = merge(base, local, remote);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(resolve(result, []), ['h', 'new', 'x', 'y', 't']);
});

test('同一位置的不同插入形成冲突，相同插入只保留一次', () => {
  const base = ['a', 'b'];
  const result = merge(base, ['a', 'L', 'b'], ['a', 'R', 'b']);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0], {
    baseStart: 1,
    baseEnd: 1,
    baseLines: [],
    localLines: ['L'],
    remoteLines: ['R'],
  });
  assert.deepEqual(resolve(result, ['local']), ['a', 'L', 'b']);
  assert.deepEqual(resolve(result, ['remote']), ['a', 'R', 'b']);
  // 相同插入去重。
  const same = merge(base, ['a', 'S', 'b'], ['a', 'S', 'b']);
  assert.equal(same.conflicts.length, 0);
  assert.deepEqual(resolve(same, []), ['a', 'S', 'b']);
});

test('重叠关系可传递：链式重叠只产生一个冲突，未改动行不遗漏', () => {
  const base = ['0', '1', '2', '3', '4', '5'];
  // 本地两处替换分别与修订的一处替换重叠，经传递连成一组。
  const local = ['L01', '2', 'L34', '5'];
  const remote = ['0', 'R123', '4', '5'];
  const result = merge(base, local, remote);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0], {
    baseStart: 0,
    baseEnd: 5,
    baseLines: ['0', '1', '2', '3', '4'],
    localLines: ['L01', '2', 'L34'],
    remoteLines: ['0', 'R123', '4'],
  });
  assert.deepEqual(resolve(result, ['local']), ['L01', '2', 'L34', '5']);
  assert.deepEqual(resolve(result, ['remote']), ['0', 'R123', '4', '5']);
});

test('大替换跨越对方多处修改，边界插入独立保留，选任一侧不漏行不重复', () => {
  const base = ['a', 'b', 'c', 'd', 'e', 'g', 'f'];
  // 本地：把 b..g 整段替换为 B C D E G，一次跨越对方多处修改的大替换。
  const local = ['a', 'B', 'C', 'D', 'E', 'G', 'f'];
  // 修订：在替换起点处插入 rh、改 c 与 e 两处、在替换终点处插入 rt。
  const remote = ['a', 'rh', 'b', 'c2', 'd', 'e2', 'g', 'rt', 'f'];
  const result = merge(base, local, remote);
  // 重叠部分只形成一个冲突，未改动行 b、d、g 在修订侧片段中保留。
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0], {
    baseStart: 1,
    baseEnd: 6,
    baseLines: ['b', 'c', 'd', 'e', 'g'],
    localLines: ['B', 'C', 'D', 'E', 'G'],
    remoteLines: ['b', 'c2', 'd', 'e2', 'g'],
  });
  // 边界插入仍自动保留：rh 在冲突之前，rt 在冲突之后。
  assert.deepEqual(autoLines(result), ['a', 'rh', 'rt', 'f']);
  // 分别选取两侧：均不漏行、不重复行。
  assert.deepEqual(resolve(result, ['local']), ['a', 'rh', 'B', 'C', 'D', 'E', 'G', 'rt', 'f']);
  assert.deepEqual(resolve(result, ['remote']), ['a', 'rh', 'b', 'c2', 'd', 'e2', 'g', 'rt', 'f']);
});

test('相同输入得到相同结果', () => {
  const base = ['h', 'x', 'x', 'x', 'm', 't'];
  const local = ['h', 'L1', 'x', 'x', 'Lm', 't'];
  const remote = ['h', 'x', 'x', 'R3', 'Rm', 't'];
  assert.deepEqual(merge(base, local, remote), merge(base, local, remote));
});

test('choices 数量不匹配时报错', () => {
  const result = merge(['a'], ['b'], ['c']);
  assert.throws(() => resolve(result, []));
});
