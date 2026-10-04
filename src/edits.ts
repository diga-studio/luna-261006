import type { Edit } from './types';

/** 由匹配结果推导连续替换序列（含纯插入、纯删除及首尾区间）。 */
export function computeEdits(
  base: string[],
  next: string[],
  matches: Array<[number, number]>,
): Edit[] {
  const edits: Edit[] = [];
  let prevBase = 0;
  let prevNext = 0;
  const pushGap = (baseEnd: number, nextEnd: number): void => {
    if (prevBase < baseEnd || prevNext < nextEnd) {
      edits.push({
        baseStart: prevBase,
        baseEnd,
        lines: next.slice(prevNext, nextEnd),
      });
    }
  };
  for (const [baseIndex, nextIndex] of matches) {
    pushGap(baseIndex, nextIndex);
    prevBase = baseIndex + 1;
    prevNext = nextIndex + 1;
  }
  pushGap(base.length, next.length);
  return edits;
}
