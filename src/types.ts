/** A concept node on the canvas. */
export interface CanvasNode {
  /** Unique positive integer id. */
  id: number;
  title: string;
  /** Integer canvas coordinates. */
  x: number;
  y: number;
}

/** A directed relation from `from` to `to`. */
export interface CanvasEdge {
  from: number;
  to: number;
}

/** The immutable input graph. */
export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** A reference entry: an edge that was not chosen as a parent-child link. */
export interface ReferenceEntry {
  targetId: number;
  targetTitle: string;
}

/** A full entry in the exported hierarchy. */
export interface OutlineEntry {
  id: number;
  title: string;
  /** Full entries nested under this one. */
  children: OutlineEntry[];
  /** Reference entries anchored at this node (not expanded). */
  references: ReferenceEntry[];
}

/** Maps a node to its parent node id, or 0 when it is a top-level entry. */
export interface ParentAssignment {
  nodeId: number;
  parentId: number;
}

/** The export result handed back to the caller. */
export interface OutlineResult {
  /** Top-level full entries, sorted by node id. */
  entries: OutlineEntry[];
  /** Parent of every node, sorted by nodeId ascending. parentId 0 = top-level. */
  parents: ParentAssignment[];
  /** Total spatial cost of all parent-child edges. */
  totalCost: number;
  /** Rendered Markdown outline. */
  markdown: string;
}
