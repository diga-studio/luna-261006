import type { EditOp } from './types.js';

/** 内存中的树结构：批量校验与重算的纯逻辑层。 */
export interface TreeState {
  rootId: string;
  parent: Map<string, string | null>;
  children: Map<string, string[]>;
}

export interface ParentUpdate {
  nodeId: string;
  parentId: string;
}

export type PlanResult =
  | {
      ok: true;
      /** 父指针发生变化的节点。 */
      parentUpdates: ParentUpdate[];
      /** 每个受影响父节点的最终孩子列表（用于落盘与同步内存缓存）。 */
      finalChildren: Map<string, string[]>;
    }
  | { ok: false; reason: string };

export const MAX_EDITS_PER_BATCH = 50;
export const MAX_DEPTH = 12;

/**
 * 依据当前树与整批编辑，校验并计算目标状态（不落盘）。
 * 整批同时表达目标状态：结果与编辑排列顺序无关，
 * 合法性只取决于最终树（连通、无环、深度不超过 MAX_DEPTH）。
 */
export function planBatch(state: TreeState, edits: EditOp[]): PlanResult {
  if (edits.length > MAX_EDITS_PER_BATCH) {
    return { ok: false, reason: 'too_many_edits' };
  }

  const editByNode = new Map<string, EditOp>();
  for (const edit of edits) {
    if (!Number.isInteger(edit.position) || edit.position < 0) {
      return { ok: false, reason: 'invalid_position' };
    }
    if (editByNode.has(edit.nodeId)) {
      return { ok: false, reason: 'duplicate_node' };
    }
    if (!state.parent.has(edit.nodeId)) {
      return { ok: false, reason: 'node_not_found' };
    }
    if (edit.nodeId === state.rootId) {
      return { ok: false, reason: 'cannot_move_root' };
    }
    if (!state.parent.has(edit.newParentId)) {
      return { ok: false, reason: 'parent_not_found' };
    }
    editByNode.set(edit.nodeId, edit);
  }

  const finalParentOf = (id: string): string | null => {
    const edit = editByNode.get(id);
    return edit ? edit.newParentId : (state.parent.get(id) ?? null);
  };

  // 按目标父节点分组编辑
  const editsByTarget = new Map<string, EditOp[]>();
  for (const edit of edits) {
    const list = editsByTarget.get(edit.newParentId) ?? [];
    list.push(edit);
    editsByTarget.set(edit.newParentId, list);
  }

  // 受影响的父节点：编辑的目标父节点，以及失去孩子的原父节点
  const affectedParents = new Set<string>(editsByTarget.keys());
  for (const edit of edits) {
    const oldParent = state.parent.get(edit.nodeId);
    if (oldParent !== null && oldParent !== undefined) {
      affectedParents.add(oldParent);
    }
  }

  // 计算每个受影响父节点的最终孩子列表
  const finalChildren = new Map<string, string[]>();
  for (const parentId of affectedParents) {
    const current = state.children.get(parentId) ?? [];
    const staying = current.filter((childId) => finalParentOf(childId) === parentId);
    const targets = editsByTarget.get(parentId) ?? [];
    const incoming = targets.filter(
      (edit) => state.parent.get(edit.nodeId) !== parentId,
    );
    const k = staying.length + incoming.length;

    const specified = new Map<string, number>();
    for (const edit of targets) {
      if (edit.position >= k) {
        return { ok: false, reason: 'position_out_of_range' };
      }
      specified.set(edit.nodeId, edit.position);
    }
    const usedPositions = new Set(specified.values());
    if (usedPositions.size !== specified.size) {
      return { ok: false, reason: 'duplicate_position' };
    }

    const finalList: (string | null)[] = new Array<string | null>(k).fill(null);
    for (const [nodeId, position] of specified) {
      finalList[position] = nodeId;
    }
    // 未被指定的孩子按编辑前的相对顺序填满剩余位置
    const unspecified = staying.filter((childId) => !specified.has(childId));
    let cursor = 0;
    for (const childId of unspecified) {
      while (finalList[cursor] !== null) {
        cursor += 1;
      }
      finalList[cursor] = childId;
    }
    finalChildren.set(parentId, finalList as string[]);
  }

  // 连通性 / 无环 / 深度校验：从根对最终树做一次迭代 DFS。
  // 每个节点只有一个最终父指针（函数图），因此从根不可达即意味着
  // 存在脱离主树的环或不连通；访问计数不足即拒绝。
  const finalKidsOf = (id: string): string[] =>
    finalChildren.get(id) ?? state.children.get(id) ?? [];
  const color = new Map<string, number>(); // 1=栈中 2=完成
  const stack: Array<{ id: string; depth: number; nextIndex: number }> = [
    { id: state.rootId, depth: 1, nextIndex: 0 },
  ];
  color.set(state.rootId, 1);
  let visited = 0;
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const kids = finalKidsOf(top.id);
    if (top.nextIndex < kids.length) {
      const kid = kids[top.nextIndex];
      top.nextIndex += 1;
      const kidColor = color.get(kid);
      if (kidColor === 1) {
        return { ok: false, reason: 'cycle' };
      }
      if (kidColor === undefined) {
        const kidDepth = top.depth + 1;
        if (kidDepth > MAX_DEPTH) {
          return { ok: false, reason: 'max_depth_exceeded' };
        }
        color.set(kid, 1);
        stack.push({ id: kid, depth: kidDepth, nextIndex: 0 });
      }
    } else {
      color.set(top.id, 2);
      visited += 1;
      stack.pop();
    }
  }
  if (visited !== state.parent.size) {
    return { ok: false, reason: 'cycle' };
  }

  // 汇总父指针发生变化的节点（孩子顺序变化由 finalChildren 整体覆盖）
  const parentUpdates: ParentUpdate[] = [];
  for (const edit of edits) {
    if (state.parent.get(edit.nodeId) !== edit.newParentId) {
      parentUpdates.push({ nodeId: edit.nodeId, parentId: edit.newParentId });
    }
  }

  return { ok: true, parentUpdates, finalChildren };
}
