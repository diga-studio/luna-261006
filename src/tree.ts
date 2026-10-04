import { BatchValidationError } from './errors.js';
import type { EditOperation, MindMapNodeInput, NodeId, TreeState } from './types.js';

/** 单张图允许的最大深度（根为第 1 层）。 */
export const MAX_DEPTH = 12;
/** 每批最多编辑的不同节点数。 */
export const MAX_EDITS_PER_BATCH = 50;

/**
 * 由有序输入树构建扁平状态。
 * 输入保证是一棵合法有序树，此处只做展开与深度上限校验。
 */
export function buildStateFromInput(root: MindMapNodeInput): TreeState {
  const parent = new Map<NodeId, NodeId>();
  const children = new Map<NodeId, NodeId[]>();
  const stack: { node: MindMapNodeInput; depth: number }[] = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) {
      throw new BatchValidationError('DEPTH_EXCEEDED', `node ${node.id} exceeds max depth ${MAX_DEPTH}`);
    }
    const kids = node.children ?? [];
    children.set(node.id, kids.map((k) => k.id));
    for (const kid of kids) {
      parent.set(kid.id, node.id);
      stack.push({ node: kid, depth: depth + 1 });
    }
  }
  return { rootId: root.id, parent, children };
}

/**
 * 在当前状态上整体应用一批编辑，返回新状态。
 * 纯函数：不修改传入的 state；任何一项不合法都抛 BatchValidationError。
 * 结果只取决于最终树，与批内操作排列无关。
 */
export function applyBatch(state: TreeState, edits: EditOperation[]): TreeState {
  if (edits.length > MAX_EDITS_PER_BATCH) {
    throw new BatchValidationError(
      'TOO_MANY_EDITS',
      `batch has ${edits.length} edits, max is ${MAX_EDITS_PER_BATCH}`,
    );
  }

  // 1. 基本校验：节点不同、存在、非根；新父节点存在于同一张图。
  const editByNode = new Map<NodeId, EditOperation>();
  for (const edit of edits) {
    if (editByNode.has(edit.nodeId)) {
      throw new BatchValidationError('DUPLICATE_NODE', `node ${edit.nodeId} edited twice in one batch`);
    }
    editByNode.set(edit.nodeId, edit);
    if (!state.children.has(edit.nodeId)) {
      throw new BatchValidationError('NODE_NOT_FOUND', `node ${edit.nodeId} does not exist`);
    }
    if (edit.nodeId === state.rootId) {
      throw new BatchValidationError('ROOT_NOT_MOVABLE', 'root node cannot be moved');
    }
    if (!state.children.has(edit.newParentId)) {
      throw new BatchValidationError('PARENT_NOT_FOUND', `parent ${edit.newParentId} does not exist`);
    }
    if (!Number.isInteger(edit.position) || edit.position < 0) {
      throw new BatchValidationError('INVALID_POSITION', `position ${edit.position} is not a non-negative integer`);
    }
  }

  // 2. 最终父节点函数：被指定的用新父节点，其余保留原父节点。
  const finalParentOf = (id: NodeId): NodeId | undefined => {
    const edit = editByNode.get(id);
    if (edit) return edit.newParentId;
    return state.parent.get(id);
  };

  // 3. 无环校验：沿最终父链向上走，回到自身即成环
  // （未编辑节点的祖先链不变，链长不超过深度上限，代价极小）。
  for (const edit of edits) {
    let cursor: NodeId | undefined = edit.newParentId;
    while (cursor !== undefined) {
      if (cursor === edit.nodeId) {
        throw new BatchValidationError('CYCLE', `moving ${edit.nodeId} would create a cycle`);
      }
      cursor = finalParentOf(cursor);
    }
  }

  // 4. 重建受影响父节点的孩子列表。
  const newChildren = new Map<NodeId, NodeId[]>(state.children);
  const affectedParents = new Set<NodeId>();
  for (const edit of edits) {
    const oldParent = state.parent.get(edit.nodeId)!;
    affectedParents.add(oldParent);
    affectedParents.add(edit.newParentId);
  }
  for (const parentId of affectedParents) {
    const oldKids = state.children.get(parentId)!;
    // 剩余孩子 = 未被编辑的老孩子；被编辑且仍归属此父节点的走指定位置。
    const staying = oldKids.filter((id) => !editByNode.has(id));
    const incoming = edits.filter((e) => e.newParentId === parentId);
    const k = staying.length + incoming.length;
    const slots: (NodeId | undefined)[] = new Array(k);
    const seenPositions = new Set<number>();
    for (const edit of incoming) {
      if (edit.position >= k) {
        throw new BatchValidationError(
          'POSITION_OUT_OF_RANGE',
          `position ${edit.position} out of range for parent ${parentId} with ${k} final children`,
        );
      }
      if (seenPositions.has(edit.position)) {
        throw new BatchValidationError(
          'POSITION_CONFLICT',
          `duplicate final position ${edit.position} under parent ${parentId}`,
        );
      }
      seenPositions.add(edit.position);
      slots[edit.position] = edit.nodeId;
    }
    let cursor = 0;
    for (const id of staying) {
      while (slots[cursor] !== undefined) cursor += 1;
      slots[cursor] = id;
    }
    newChildren.set(parentId, slots as NodeId[]);
  }

  // 5. 新父节点映射。
  const newParent = new Map<NodeId, NodeId>(state.parent);
  for (const edit of edits) {
    newParent.set(edit.nodeId, edit.newParentId);
  }
  const next: TreeState = { rootId: state.rootId, parent: newParent, children: newChildren };

  // 6. 深度与连通性校验：从根遍历最终树，所有节点可达且深度不超过上限。
  const totalNodes = newChildren.size;
  let visited = 0;
  const stack: { id: NodeId; depth: number }[] = [{ id: state.rootId, depth: 1 }];
  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) {
      throw new BatchValidationError('DEPTH_EXCEEDED', `node ${id} would exceed max depth ${MAX_DEPTH}`);
    }
    visited += 1;
    for (const kid of newChildren.get(id)!) {
      stack.push({ id: kid, depth: depth + 1 });
    }
  }
  if (visited !== totalNodes) {
    throw new BatchValidationError('DISCONNECTED', 'final tree is not connected');
  }

  return next;
}
