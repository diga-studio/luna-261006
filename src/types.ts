/** 节点标识，全图唯一且不变。 */
export type NodeId = string;

/** 初始化时输入的有序树节点。 */
export interface MindMapNodeInput {
  id: NodeId;
  children?: MindMapNodeInput[];
}

/** 读取导图时返回的有序树节点视图。 */
export interface MindMapNodeView {
  id: NodeId;
  children: MindMapNodeView[];
}

/** 单条搬迁/重排指令：把 nodeId 挂到 newParentId 下最终孩子列表的 position 处。 */
export interface EditOperation {
  nodeId: NodeId;
  newParentId: NodeId;
  position: number;
}

/** 一次批量编辑。 */
export interface BatchEdit {
  /** 调用方读到的版本，仅当仍是当前版本时才允许提交。 */
  baseVersion: number;
  edits: EditOperation[];
}

/** 读取导图的结果：完整树 + 版本。 */
export interface MindMapSnapshot {
  mapId: string;
  version: number;
  root: MindMapNodeView;
}

/** 提交成功的结果。 */
export interface CommitResult {
  version: number;
}

/** 导图在内存中的扁平状态（供内部使用）。 */
export interface TreeState {
  rootId: NodeId;
  /** node -> parent（根无条目）。 */
  parent: Map<NodeId, NodeId>;
  /** parent -> 有序孩子列表。 */
  children: Map<NodeId, NodeId[]>;
}
