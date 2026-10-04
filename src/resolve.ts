import type { MergeResult, Side } from './types';

/**
 * 按冲突选择生成最终文档。choices[i] 为 conflicts[i] 的选择，
 * 每个冲突都必须给出选择。
 */
export function resolveMerge(result: MergeResult, choices: Side[]): string[] {
  if (choices.length !== result.conflicts.length) {
    throw new Error(
      'choices 数量 (' + choices.length + ') 与冲突数量 (' + result.conflicts.length + ') 不一致',
    );
  }
  const out: string[] = [];
  for (const segment of result.segments) {
    if (segment.type === 'lines') {
      out.push(...segment.lines);
      continue;
    }
    const conflict = result.conflicts[segment.conflictIndex];
    const choice = choices[segment.conflictIndex];
    if (!conflict || (choice !== 'local' && choice !== 'revised')) {
      throw new Error('冲突 ' + segment.conflictIndex + ' 缺少有效选择（local 或 revised）');
    }
    out.push(...conflict[choice]);
  }
  return out;
}
