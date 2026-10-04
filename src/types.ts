/** A node on the MindForge canvas. */
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

/** The input graph. Treated as immutable during a single export call. */
export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** A reference entry: an original edge that was not chosen as a parent link. */
export interface OutlineReference {
  /** Id of the edge target node. */
  targetId: number;
  targetTitle: string;
}

/** A full entry in the exported hierarchy. */
export interface OutlineEntry {
  nodeId: number;
  title: string;
  /** Parent node id, or 0 when this entry sits at the top level. */
  parentId: number;
  children: OutlineEntry[];
  /** Original edges leaving this node that are not parent links. */
  references: OutlineReference[];
}

/** Result of an export: inspectable hierarchy plus Markdown text. */
export interface OutlineResult {
  /** Top-level full entries. */
  roots: OutlineEntry[];
  /** nodeId -> parentId (0 for top-level entries). */
  parents: ReadonlyMap<number, number>;
  /** Total spatial cost of the chosen parent links. */
  totalCost: number;
  markdown: string;
}
