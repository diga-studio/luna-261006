import type {
  CellPatch,
  EngineOptions,
  Inspection,
  RowInspection,
  UndoRedoResult,
} from "./types";

const MAX_OPS_PER_SESSION = 50;
const MAX_SNAPSHOTS_PER_ROW = 20;

interface CellState<V> {
  value: V;
  stateId: number;
}

interface WriteRecord<V> {
  cellKey: string;
  rowKey: string;
  before: CellState<V>;
  after: CellState<V>;
}

interface Operation<V> {
  id: number;
  writes: WriteRecord<V>[];
  undone: boolean;
}

function cellKeyOf(grid: string, row: number, col: number): string {
  return `${grid} ${row} ${col}`;
}

function rowKeyOf(grid: string, row: number): string {
  return `${grid} ${row}`;
}

function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepCopy(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = deepCopy(entry);
    }
    return out as T;
  }
  return value;
}

/**
 * Session-scoped undo/redo engine for PixelGrid.
 * Structure (grids, rows, cols) is fixed at construction time.
 */
export class PixelGridUndoEngine<V> {
  private readonly grids: readonly string[];
  private readonly rows: number;
  private readonly cols: number;
  private readonly cells = new Map<string, CellState<V>>();
  private readonly rowVersions = new Map<string, number>();
  private readonly rowSnapshots = new Map<
    string,
    Array<{ version: number; values: V[] }>
  >();
  private readonly sessions = new Map<string, Array<Operation<V>>>();
  private nextOpId = 1;
  private nextStateId = 1;

  constructor(options: EngineOptions<V>) {
    this.grids = [...options.grids];
    this.rows = options.rows;
    this.cols = options.cols;
    for (const grid of this.grids) {
      for (let row = 0; row < this.rows; row += 1) {
        this.rowVersions.set(rowKeyOf(grid, row), 0);
        this.rowSnapshots.set(rowKeyOf(grid, row), []);
        for (let col = 0; col < this.cols; col += 1) {
          this.cells.set(cellKeyOf(grid, row, col), {
            value: options.initialValue,
            stateId: 0,
          });
        }
      }
    }
  }

  /** Applies one logical edit batch; returns the unique op id. */
  edit(sessionId: string, patches: readonly CellPatch<V>[]): number {
    const writes: WriteRecord<V>[] = patches.map((patch) => {
      const cellKey = cellKeyOf(patch.addr.grid, patch.addr.row, patch.addr.col);
      const before = this.cells.get(cellKey);
      if (before === undefined) {
        throw new Error(`unknown cell: ${cellKey}`);
      }
      return {
        cellKey,
        rowKey: rowKeyOf(patch.addr.grid, patch.addr.row),
        before: { ...before },
        after: { value: patch.value, stateId: this.allocStateId() },
      };
    });
    for (const write of writes) {
      this.cells.set(write.cellKey, { ...write.after });
    }
    const op: Operation<V> = { id: this.nextOpId, writes, undone: false };
    this.nextOpId += 1;
    const list = this.sessionList(sessionId);
    while (list.length > 0 && list[list.length - 1]!.undone) {
      list.pop();
    }
    list.push(op);
    while (list.length > MAX_OPS_PER_SESSION) {
      list.shift();
    }
    this.commitRows(writes);
    return op.id;
  }

  /** Undoes this session's most recent not-yet-undone op, if unblocked. */
  undo(sessionId: string): UndoRedoResult {
    const list = this.sessions.get(sessionId);
    if (list === undefined) {
      return { ok: false };
    }
    let op: Operation<V> | undefined;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (!list[i]!.undone) {
        op = list[i];
        break;
      }
    }
    if (op === undefined) {
      return { ok: false };
    }
    for (const write of op.writes) {
      if (this.cells.get(write.cellKey)!.stateId !== write.after.stateId) {
        return { ok: false };
      }
    }
    for (const write of op.writes) {
      this.cells.set(write.cellKey, { ...write.before });
    }
    op.undone = true;
    this.commitRows(op.writes);
    return { ok: true, opId: op.id };
  }

  /** Redoes this session's most recently undone op, if unblocked. */
  redo(sessionId: string): UndoRedoResult {
    const list = this.sessions.get(sessionId);
    if (list === undefined || list.length === 0) {
      return { ok: false };
    }
    // Ops form an active prefix followed by an undone suffix; the most
    // recently undone op is the first one of that suffix.
    const op = list.find((candidate) => candidate.undone);
    if (op === undefined) {
      return { ok: false };
    }
    for (const write of op.writes) {
      if (this.cells.get(write.cellKey)!.stateId !== write.before.stateId) {
        return { ok: false };
      }
    }
    for (const write of op.writes) {
      this.cells.set(write.cellKey, { ...write.after });
    }
    op.undone = false;
    this.commitRows(op.writes);
    return { ok: true, opId: op.id };
  }

  /** Deep-copied view of values, row versions/snapshots and session stacks. */
  inspect(): Inspection<V> {
    const cells: Record<string, V[][]> = {};
    const rows: Record<string, RowInspection<V>> = {};
    for (const grid of this.grids) {
      const gridCells: V[][] = [];
      for (let row = 0; row < this.rows; row += 1) {
        const values: V[] = [];
        for (let col = 0; col < this.cols; col += 1) {
          values.push(this.cells.get(cellKeyOf(grid, row, col))!.value);
        }
        gridCells.push(values);
        const rowKey = rowKeyOf(grid, row);
        rows[`${grid}/${row}`] = {
          version: this.rowVersions.get(rowKey)!,
          snapshots: this.rowSnapshots.get(rowKey)!.map((snap) => ({
            version: snap.version,
            values: [...snap.values],
          })),
        };
      }
      cells[grid] = gridCells;
    }
    const sessions: Inspection<V>["sessions"] = {};
    for (const [sessionId, list] of this.sessions) {
      sessions[sessionId] = {
        undoable: list.filter((op) => !op.undone).map((op) => op.id),
        redoable: list.filter((op) => op.undone).map((op) => op.id),
      };
    }
    return deepCopy({ cells, rows, sessions });
  }

  private allocStateId(): number {
    const id = this.nextStateId;
    this.nextStateId += 1;
    return id;
  }

  private sessionList(sessionId: string): Array<Operation<V>> {
    let list = this.sessions.get(sessionId);
    if (list === undefined) {
      list = [];
      this.sessions.set(sessionId, list);
    }
    return list;
  }

  private commitRows(writes: readonly WriteRecord<V>[]): void {
    const rowKeys: string[] = [];
    const seen = new Set<string>();
    for (const write of writes) {
      if (!seen.has(write.rowKey)) {
        seen.add(write.rowKey);
        rowKeys.push(write.rowKey);
      }
    }
    for (const rowKey of rowKeys) {
      const version = this.rowVersions.get(rowKey)! + 1;
      this.rowVersions.set(rowKey, version);
      const separator = rowKey.lastIndexOf(" ");
      const grid = rowKey.slice(0, separator);
      const row = Number(rowKey.slice(separator + 1));
      const values: V[] = [];
      for (let col = 0; col < this.cols; col += 1) {
        values.push(this.cells.get(cellKeyOf(grid, row, col))!.value);
      }
      const snapshots = this.rowSnapshots.get(rowKey)!;
      snapshots.push({ version, values });
      while (snapshots.length > MAX_SNAPSHOTS_PER_ROW) {
        snapshots.shift();
      }
    }
  }
}
