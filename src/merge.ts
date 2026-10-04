import { computeEdits } from './edits';
import { matchLines } from './match';
import type { Conflict, Edit, MergeResult, Segment } from './types';

interface SideEdit extends Edit {
  side: 0 | 1;
}

function editKey(edit: Edit): string {
  return edit.baseStart + ':' + edit.baseEnd + ':' + JSON.stringify(edit.lines);
}

/**
 * 重叠判定：替换区间按半开区间相交；插入点严格位于区间内部才算重叠；
 * 同一位置的不同插入算重叠；首尾相接不算重叠。
 */
function overlaps(a: Edit, b: Edit): boolean {
  const aIsInsert = a.baseStart === a.baseEnd;
  const bIsInsert = b.baseStart === b.baseEnd;
  if (aIsInsert && bIsInsert) return a.baseStart === b.baseStart;
  if (aIsInsert) return b.baseStart < a.baseStart && a.baseStart < b.baseEnd;
  if (bIsInsert) return a.baseStart < b.baseStart && b.baseStart < a.baseEnd;
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

/** 把一侧在 [start, end) 内的修改应用到底稿片段上，未改动行原样保留。 */
function applySideEdits(base: string[], edits: Edit[], start: number, end: number): string[] {
  const sorted = [...edits].sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);
  const out: string[] = [];
  let pos = start;
  for (const edit of sorted) {
    for (let i = pos; i < edit.baseStart; i++) out.push(base[i] as string);
    out.push(...edit.lines);
    pos = edit.baseEnd;
  }
  for (let i = pos; i < end; i++) out.push(base[i] as string);
  return out;
}

/** 三方合并：共同底稿、本地稿、修订稿（均已拆成行）。 */
export function mergeDocuments(
  base: string[],
  local: string[],
  revised: string[],
): MergeResult {
  const localEdits = computeEdits(base, local, matchLines(base, local));
  const revisedEdits = computeEdits(base, revised, matchLines(base, revised));

  // 两侧完全相同的修改只保留一次，直接作为自动合并内容。
  const localKeys = new Set(localEdits.map(editKey));
  const revisedKeys = new Set(revisedEdits.map(editKey));
  const autoEdits: Edit[] = [];
  const localRest: Edit[] = [];
  for (const edit of localEdits) {
    if (revisedKeys.has(editKey(edit))) autoEdits.push(edit);
    else localRest.push(edit);
  }
  const revisedRest = revisedEdits.filter((edit) => !localKeys.has(editKey(edit)));

  // 对剩余修改按重叠关系（可传递）做并查集分组。
  const all: SideEdit[] = [
    ...localRest.map((edit) => ({ ...edit, side: 0 as const })),
    ...revisedRest.map((edit) => ({ ...edit, side: 1 as const })),
  ];
  const parent = all.map((_, index) => index);
  const find = (x: number): number => {
    let root = x;
    while ((parent[root] as number) !== root) root = parent[root] as number;
    parent[x] = root;
    return root;
  };
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (overlaps(all[i] as SideEdit, all[j] as SideEdit)) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[rj] = ri;
      }
    }
  }
  const groupMap = new Map<number, SideEdit[]>();
  all.forEach((edit, index) => {
    const root = find(index);
    const group = groupMap.get(root);
    if (group) group.push(edit);
    else groupMap.set(root, [edit]);
  });

  // 单例修改自动保留；多修改组形成冲突。
  const conflicts: Conflict[] = [];
  interface ConflictItem {
    baseStart: number;
    baseEnd: number;
    conflictIndex: number;
  }
  const conflictItems: ConflictItem[] = [];
  for (const group of groupMap.values()) {
    if (group.length === 1) {
      const edit = group[0] as SideEdit;
      autoEdits.push({ baseStart: edit.baseStart, baseEnd: edit.baseEnd, lines: edit.lines });
      continue;
    }
    const baseStart = Math.min(...group.map((edit) => edit.baseStart));
    const baseEnd = Math.max(...group.map((edit) => edit.baseEnd));
    const localSide = group.filter((edit) => edit.side === 0);
    const revisedSide = group.filter((edit) => edit.side === 1);
    const conflictIndex = conflicts.length;
    conflicts.push({
      index: conflictIndex,
      baseStart,
      baseEnd,
      base: base.slice(baseStart, baseEnd),
      local: applySideEdits(base, localSide, baseStart, baseEnd),
      revised: applySideEdits(base, revisedSide, baseStart, baseEnd),
    });
    conflictItems.push({ baseStart, baseEnd, conflictIndex });
  }
  // 冲突按底稿位置排序，保证相同输入得到相同的冲突顺序。
  conflictItems.sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);
  const reordered: Conflict[] = conflictItems.map(
    (item, newIndex) => ({ ...(conflicts[item.conflictIndex] as Conflict), index: newIndex }),
  );
  conflictItems.forEach((item, newIndex) => {
    item.conflictIndex = newIndex;
  });

  // 输出片段：自动合并的修改与冲突块按底稿位置交错；
  // 同一位置上纯插入排在以其起点开始的区间之前、以其终点结束的区间之后。
  interface OutputItem {
    baseStart: number;
    baseEnd: number;
    kind: 'edit' | 'conflict';
    edit?: Edit;
    conflictIndex?: number;
  }
  const items: OutputItem[] = [
    ...autoEdits.map(
      (edit): OutputItem => ({
        baseStart: edit.baseStart,
        baseEnd: edit.baseEnd,
        kind: 'edit',
        edit,
      }),
    ),
    ...conflictItems.map(
      (item): OutputItem => ({
        baseStart: item.baseStart,
        baseEnd: item.baseEnd,
        kind: 'conflict',
        conflictIndex: item.conflictIndex,
      }),
    ),
  ];
  items.sort((a, b) => {
    if (a.baseStart !== b.baseStart) return a.baseStart - b.baseStart;
    const aInsert = a.baseStart === a.baseEnd ? 0 : 1;
    const bInsert = b.baseStart === b.baseEnd ? 0 : 1;
    return aInsert - bInsert;
  });

  const segments: Segment[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length > 0) {
      segments.push({ type: 'lines', lines: buffer });
      buffer = [];
    }
  };
  let pos = 0;
  for (const item of items) {
    for (let i = pos; i < item.baseStart; i++) buffer.push(base[i] as string);
    if (item.kind === 'edit') {
      buffer.push(...(item.edit as Edit).lines);
    } else {
      flush();
      segments.push({ type: 'conflict', conflictIndex: item.conflictIndex as number });
    }
    pos = item.baseEnd;
  }
  for (let i = pos; i < base.length; i++) buffer.push(base[i] as string);
  flush();

  return { segments, conflicts: reordered };
}
