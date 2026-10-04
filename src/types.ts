/** Address of a single cell inside a grid. */
export interface CellAddress {
  grid: string;
  row: number;
  col: number;
}

/** One cell write inside a logical edit batch. */
export interface CellPatch<V> {
  addr: CellAddress;
  value: V;
}

/** Constructor options: fixed structure, no add/remove afterwards. */
export interface EngineOptions<V> {
  grids: readonly string[];
  rows: number;
  cols: number;
  initialValue: V;
}

/** Result of an undo/redo attempt. */
export type UndoRedoResult =
  | { ok: true; opId: number }
  | { ok: false };

/** Post-commit snapshot of one row. */
export interface RowSnapshot<V> {
  version: number;
  values: V[];
}

export interface RowInspection<V> {
  version: number;
  snapshots: RowSnapshot<V>[];
}

export interface SessionInspection {
  undoable: number[];
  redoable: number[];
}

/** Read-only view returned by inspect(); never aliases internal state. */
export interface Inspection<V> {
  cells: Record<string, V[][]>;
  rows: Record<string, RowInspection<V>>;
  sessions: Record<string, SessionInspection>;
}
