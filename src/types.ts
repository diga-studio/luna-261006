/** 初始化时的有序树节点输入。 */
export interface InitNode {
  id: string;
  children?: InitNode[];
}

/** 单条批量编辑：把 nodeId 搬到 newParentId 下，落在最终孩子列表的 position（从 0 开始）。 */
export interface EditOp {
  nodeId: string;
  newParentId: string;
  position: number;
}

/** 读取导图得到的快照。 */
export interface MapSnapshot {
  mapId: string;
  version: number;
  /** 每个节点的父节点；根节点为 null。 */
  parents: Record<string, string | null>;
  /** 每个父节点下按顺序排列的孩子 id 列表。 */
  children: Record<string, string[]>;
  rootId: string;
}

export type SubmitResult =
  | { ok: true; version: number }
  | { ok: false; reason: string };
