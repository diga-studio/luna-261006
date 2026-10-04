import { computeEdits, matchLines } from './diff';
import type {
  Conflict,
  ConflictChoice,
  Edit,
  MergeChunk,
  MergeResult,
} from './types';

function isInsert(edit: Edit): boolean {
  return edit.baseStart === edit.baseEnd;
}

function sameEdit(a: Edit, b: Edit): boolean {
  return (
    a.baseStart === b.baseStart &&
    a.baseEnd === b.baseEnd &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line === b.lines[i])
  );
}

/**
 * 两次替换是否重叠。首尾相接不算；插入点严格位于被替换范围内部才算，
 * 位于边界不算；同一位置的不同插入算重叠。
 */
function overlaps(a: Edit, b: Edit): boolean {
  const aIns = isInsert(a);
  const bIns = isInsert(b);
  if (aIns && bIns) return a.baseStart === b.baseStart;
  if (aIns) return b.baseStart < a.baseStart && a.baseStart < b.baseEnd;
  if (bIns) return a.baseStart < b.baseStart && b.baseStart < a.baseEnd;
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

/** 把一侧在一组冲突内的修改应用到底稿区间上，未改动行原样保留。 */
function applyEdits(base: string[], start: number, end: number, edits: Edit[]): string[] {
  const out: string[] = [];
  let pos = start;
  for (const edit of edits) {
    for (let i = pos; i < edit.baseStart; i++) out.push(base[i]!);
    out.push(...edit.lines);
    pos = edit.baseEnd;
  }
  for (let i = pos; i < end; i++) out.push(base[i]!);
  return out;
}

interface Group {
  local: Edit[];
  remote: Edit[];
  baseStart: number;
  baseEnd: number;
}

/** 通过重叠关系的传递闭包把两侧修改连成组。 */
function buildGroups(localEdits: Edit[], remoteEdits: Edit[]): Group[] {
  const parent = (idx: number, roots: number[]): number => {
    let r = idx;
    while (roots[r] !== r) r = roots[r]!;
    let c = idx;
    while (roots[c] !== c) {
      const next = roots[c]!;
      roots[c] = r;
      c = next;
    }
    return r;
  };
  const total = localEdits.length + remoteEdits.length;
  const roots = Array.from({ length: total }, (_, i) => i);
  const union = (a: number, b: number): void => {
    const ra = parent(a, roots);
    const rb = parent(b, roots);
    if (ra !== rb) roots[rb] = ra;
  };
  localEdits.forEach((edit, i) => {
    remoteEdits.forEach((other, j) => {
      if (overlaps(edit, other)) union(i, localEdits.length + j);
    });
  });
  const byRoot = new Map<number, Group>();
  const groupOf = (idx: number): Group => {
    const root = parent(idx, roots);
    let group = byRoot.get(root);
    if (!group) {
      group = { local: [], remote: [], baseStart: Infinity, baseEnd: -Infinity };
      byRoot.set(root, group);
    }
    return group;
  };
  localEdits.forEach((edit, i) => {
    const group = groupOf(i);
    group.local.push(edit);
    group.baseStart = Math.min(group.baseStart, edit.baseStart);
    group.baseEnd = Math.max(group.baseEnd, edit.baseEnd);
  });
  remoteEdits.forEach((edit, j) => {
    const group = groupOf(localEdits.length + j);
    group.remote.push(edit);
    group.baseStart = Math.min(group.baseStart, edit.baseStart);
    group.baseEnd = Math.max(group.baseEnd, edit.baseEnd);
  });
  // 只含单侧修改的组不是冲突，其修改直接自动保留。
  return [...byRoot.values()].filter(
    (group) => group.local.length > 0 && group.remote.length > 0,
  );
}

/** 合并项排序键：按底稿起点，同点时纯插入排在替换之前。 */
function itemOrder(item: { baseStart: number; baseEnd: number }): [number, number] {
  return [item.baseStart, isInsert(item as Edit) ? 0 : 1];
}

/**
 * 三方合并：共同底稿、本地稿、修订稿（均已拆成行）。
 * 能共存的修改自动保留，真正冲突的部分以冲突形式返回。
 */
export function merge(
  base: string[],
  local: string[],
  remote: string[],
): MergeResult {
  const localEdits = computeEdits(base, local, matchLines(base, local));
  const remoteEdits = computeEdits(base, remote, matchLines(base, remote));

  // 两侧完全相同的修改（含同一位置的相同插入）只保留一次。
  const autoEdits: Edit[] = [];
  const localOnly: Edit[] = [];
  const usedRemote = new Array<boolean>(remoteEdits.length).fill(false);
  for (const edit of localEdits) {
    const dup = remoteEdits.findIndex(
      (other, j) => !usedRemote[j] && sameEdit(edit, other),
    );
    if (dup >= 0) {
      usedRemote[dup] = true;
      autoEdits.push(edit);
    } else {
      localOnly.push(edit);
    }
  }
  const remoteOnly = remoteEdits.filter((_, j) => !usedRemote[j]);

  const groups = buildGroups(localOnly, remoteOnly);
  const groupedLocal = new Set(groups.flatMap((g) => g.local));
  const groupedRemote = new Set(groups.flatMap((g) => g.remote));
  for (const edit of localOnly) if (!groupedLocal.has(edit)) autoEdits.push(edit);
  for (const edit of remoteOnly) if (!groupedRemote.has(edit)) autoEdits.push(edit);

  const conflicts: Conflict[] = groups.map((group) => ({
    baseStart: group.baseStart,
    baseEnd: group.baseEnd,
    baseLines: base.slice(group.baseStart, group.baseEnd),
    localLines: applyEdits(base, group.baseStart, group.baseEnd, group.local),
    remoteLines: applyEdits(base, group.baseStart, group.baseEnd, group.remote),
  }));

  type Item =
    | { kind: 'edit'; edit: Edit }
    | { kind: 'conflict'; conflictIndex: number; baseStart: number; baseEnd: number };
  const items: Item[] = [
    ...autoEdits.map((edit): Item => ({ kind: 'edit', edit })),
    ...conflicts.map((conflict, conflictIndex): Item => ({
      kind: 'conflict',
      conflictIndex,
      baseStart: conflict.baseStart,
      baseEnd: conflict.baseEnd,
    })),
  ];
  items.sort((a, b) => {
    const ka = itemOrder(a.kind === 'edit' ? a.edit : a);
    const kb = itemOrder(b.kind === 'edit' ? b.edit : b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });

  const chunks: MergeChunk[] = [];
  const pushLines = (lines: string[]): void => {
    if (lines.length === 0) return;
    const last = chunks[chunks.length - 1];
    if (last && last.kind === 'lines') last.lines.push(...lines);
    else chunks.push({ kind: 'lines', lines: [...lines] });
  };
  let basePos = 0;
  for (const item of items) {
    const start = item.kind === 'edit' ? item.edit.baseStart : item.baseStart;
    const end = item.kind === 'edit' ? item.edit.baseEnd : item.baseEnd;
    pushLines(base.slice(basePos, start));
    if (item.kind === 'edit') pushLines(item.edit.lines);
    else chunks.push({ kind: 'conflict', conflictIndex: item.conflictIndex });
    basePos = end;
  }
  pushLines(base.slice(basePos));

  return { chunks, conflicts };
}

/**
 * 对每个冲突逐个选择一侧后生成最终文档。
 * choices.length 必须等于 result.conflicts.length。
 */
export function resolve(result: MergeResult, choices: ConflictChoice[]): string[] {
  if (choices.length !== result.conflicts.length) {
    throw new Error(
      `expected ${result.conflicts.length} choices, got ${choices.length}`,
    );
  }
  const out: string[] = [];
  for (const chunk of result.chunks) {
    if (chunk.kind === 'lines') {
      out.push(...chunk.lines);
    } else {
      const conflict = result.conflicts[chunk.conflictIndex]!;
      const choice = choices[chunk.conflictIndex];
      out.push(...(choice === 'local' ? conflict.localLines : conflict.remoteLines));
    }
  }
  return out;
}
