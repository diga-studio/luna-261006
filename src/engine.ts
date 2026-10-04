import type {
  CellValue,
  EditResult,
  GridId,
  GridSpec,
  Inspection,
  OpId,
  Patch,
  RowSnapshot,
  SessionId,
  UndoRedoResult,
} from './types';

/** 每会话最多保留的可撤销/可重做操作数 */
const MAX_OPS_PER_SESSION = 50;
/** 每行最多保留的提交后快照数 */
const MAX_SNAPSHOTS_PER_ROW = 20;

/** 单元格编辑状态：值 + 来源（写入它的操作），链式连接前一状态 */
interface CellState {
  id: string;
  value: CellValue;
  prevId: string | null;
}

interface Cell {
  /** 线性状态链，下标即时间顺序；可能被裁剪，只保留可达状态 */
  states: CellState[];
  /** 当前生效状态在 states 中的下标 */
  current: number;
}

interface RowState {
  version: number;
  snapshots: RowSnapshot[];
}

interface GridState {
  id: GridId;
  rows: number;
  cols: number;
  cells: Cell[][];
  rowStates: RowState[];
}

/** 操作对单个单元格的写入记录（含前后编辑身份） */
interface OpEntry {
  grid: GridId;
  row: number;
  col: number;
  stateId: string;
  prevId: string;
}

interface OpRecord {
  id: OpId;
  sessionId: SessionId;
  /** 全局首次 edit 顺序号，用于淘汰 */
  seq: number;
  entries: OpEntry[];
}

interface SessionState {
  id: SessionId;
  /** 尚未撤销的操作，按 seq 升序 */
  active: OpRecord[];
  /** 已撤销可重做的操作，按撤销时间入栈，栈顶为最近撤销 */
  undone: OpRecord[];
}

const cloneValue = (value: CellValue): CellValue =>
  value === undefined ? undefined : structuredClone(value);

function addTouched(map: Map<GridId, Set<number>>, grid: GridId, row: number): void {
  let set = map.get(grid);
  if (!set) {
    set = new Set();
    map.set(grid, set);
  }
  set.add(row);
}

export class PixelGridUndoEngine {
  private readonly grids = new Map<GridId, GridState>();
  private readonly sessions = new Map<SessionId, SessionState>();
  private opSeq = 0;
  private stateSeq = 0;

  constructor(gridSpecs: GridSpec[]) {
    for (const spec of gridSpecs) {
      if (this.grids.has(spec.id)) {
        throw new Error(`duplicate grid id: ${spec.id}`);
      }
      const cells: Cell[][] = [];
      const rowStates: RowState[] = [];
      for (let r = 0; r < spec.rows; r++) {
        const rowCells: Cell[] = [];
        for (let c = 0; c < spec.cols; c++) {
          const initial = Array.isArray(spec.initial)
            ? (spec.initial as CellValue[][])[r]?.[c]
            : spec.initial;
          rowCells.push({
            states: [
              { id: this.nextStateId(), value: cloneValue(initial), prevId: null },
            ],
            current: 0,
          });
        }
        cells.push(rowCells);
        rowStates.push({ version: 0, snapshots: [] });
      }
      this.grids.set(spec.id, {
        id: spec.id,
        rows: spec.rows,
        cols: spec.cols,
        cells,
        rowStates,
      });
    }
  }

  edit(sessionId: SessionId, patches: Patch[]): EditResult {
    const session = this.session(sessionId);
    // 新 edit 清除本会话 redo 分支（不影响其他会话）
    session.undone = [];

    this.opSeq += 1;
    const op: OpRecord = {
      id: `op-${this.opSeq}`,
      sessionId,
      seq: this.opSeq,
      entries: [],
    };

    const touchedRows = new Map<GridId, Set<number>>();
    for (const patch of patches) {
      const grid = this.grid(patch.grid);
      const cell = grid.cells[patch.row]![patch.col]!;
      const prevId = cell.states[cell.current]!.id;
      const stateId = this.nextStateId();
      cell.states.push({ id: stateId, value: cloneValue(patch.value), prevId });
      cell.current = cell.states.length - 1;
      op.entries.push({
        grid: patch.grid,
        row: patch.row,
        col: patch.col,
        stateId,
        prevId,
      });
      addTouched(touchedRows, patch.grid, patch.row);
    }

    session.active.push(op);
    this.evict(session);
    this.commitRows(touchedRows);
    this.pruneCells();
    return { ok: true, opId: op.id };
  }

  undo(sessionId: SessionId): UndoRedoResult {
    const session = this.sessions.get(sessionId);
    const op = session?.active[session.active.length - 1];
    if (!session || !op) {
      return { ok: false, reason: 'empty' };
    }
    // 预检：目标操作必须是每个目标单元格上最近的生效编辑
    for (const entry of op.entries) {
      const cell = this.cellAt(entry);
      if (cell.states[cell.current]!.id !== entry.stateId) {
        return { ok: false, reason: 'conflict' };
      }
    }
    const touchedRows = new Map<GridId, Set<number>>();
    for (const entry of op.entries) {
      const cell = this.cellAt(entry);
      cell.current = this.stateIndex(cell, entry.prevId);
      addTouched(touchedRows, entry.grid, entry.row);
    }
    session.active.pop();
    session.undone.push(op);
    this.commitRows(touchedRows);
    this.pruneCells();
    return { ok: true, opId: op.id };
  }

  redo(sessionId: SessionId): UndoRedoResult {
    const session = this.sessions.get(sessionId);
    const op = session?.undone[session.undone.length - 1];
    if (!session || !op) {
      return { ok: false, reason: 'empty' };
    }
    // 预检：每个目标单元格必须处于该操作首次执行前的编辑状态（按身份而非值）
    for (const entry of op.entries) {
      const cell = this.cellAt(entry);
      if (cell.states[cell.current]!.id !== entry.prevId) {
        return { ok: false, reason: 'conflict' };
      }
    }
    const touchedRows = new Map<GridId, Set<number>>();
    for (const entry of op.entries) {
      const cell = this.cellAt(entry);
      cell.current = this.stateIndex(cell, entry.stateId);
      addTouched(touchedRows, entry.grid, entry.row);
    }
    session.undone.pop();
    session.active.push(op);
    this.commitRows(touchedRows);
    this.pruneCells();
    return { ok: true, opId: op.id };
  }

  inspect(): Inspection {
    return {
      grids: [...this.grids.values()].map((grid) => ({
        id: grid.id,
        rows: grid.rows,
        cols: grid.cols,
        values: grid.cells.map((row) =>
          row.map((cell) => cloneValue(cell.states[cell.current]!.value)),
        ),
        rowVersions: grid.rowStates.map((r) => r.version),
        rowSnapshots: grid.rowStates.map((r) =>
          r.snapshots.map((snap) => ({
            version: snap.version,
            values: cloneValue(snap.values) as CellValue[],
          })),
        ),
      })),
      sessions: [...this.sessions.values()].map((session) => ({
        id: session.id,
        undoable: session.active.map((op) => op.id),
        redoable: [...session.undone].reverse().map((op) => op.id),
      })),
    };
  }

  private nextStateId(): string {
    this.stateSeq += 1;
    return `s-${this.stateSeq}`;
  }

  private session(id: SessionId): SessionState {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, active: [], undone: [] };
      this.sessions.set(id, s);
    }
    return s;
  }

  private grid(id: GridId): GridState {
    const g = this.grids.get(id);
    if (!g) throw new Error(`unknown grid: ${id}`);
    return g;
  }

  private cellAt(entry: OpEntry): Cell {
    return this.grid(entry.grid).cells[entry.row]![entry.col]!;
  }

  private stateIndex(cell: Cell, stateId: string): number {
    const index = cell.states.findIndex((s) => s.id === stateId);
    if (index < 0) throw new Error(`state not retained: ${stateId}`);
    return index;
  }

  /** 超额时按首次 edit 顺序淘汰最旧操作（仅移除入口，不取消效果） */
  private evict(session: SessionState): void {
    while (session.active.length + session.undone.length > MAX_OPS_PER_SESSION) {
      const oldestActive = session.active[0];
      const oldestUndone = session.undone[0];
      if (oldestActive && (!oldestUndone || oldestActive.seq <= oldestUndone.seq)) {
        session.active.shift();
      } else {
        session.undone.shift();
      }
    }
  }

  /** 对触及的每行：版本 +1，并记录一份提交后快照（每行最多保留 20 份） */
  private commitRows(touchedRows: Map<GridId, Set<number>>): void {
    for (const [gridId, rows] of touchedRows) {
      const grid = this.grid(gridId);
      for (const row of rows) {
        const rowState = grid.rowStates[row]!;
        rowState.version += 1;
        const values = grid.cells[row]!.map(
          (cell) => cell.states[cell.current]!.value,
        );
        rowState.snapshots.push({
          version: rowState.version,
          values: cloneValue(values) as CellValue[],
        });
        if (rowState.snapshots.length > MAX_SNAPSHOTS_PER_ROW) {
          rowState.snapshots.shift();
        }
      }
    }
  }

  /** 裁剪单元格状态链：只保留当前状态与保留窗口内操作可达的前后状态 */
  private pruneCells(): void {
    // 收集每个单元格必须保留的状态 id：当前状态 + 各保留操作写入的状态及其前一状态
    const needed = new Map<string, Set<string>>();
    const need = (grid: GridId, row: number, col: number, stateId: string) => {
      const key = `${grid} ${row} ${col}`;
      let set = needed.get(key);
      if (!set) {
        set = new Set();
        needed.set(key, set);
      }
      set.add(stateId);
    };
    for (const session of this.sessions.values()) {
      for (const op of [...session.active, ...session.undone]) {
        for (const entry of op.entries) {
          need(entry.grid, entry.row, entry.col, entry.stateId);
          need(entry.grid, entry.row, entry.col, entry.prevId);
        }
      }
    }
    for (const grid of this.grids.values()) {
      for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
          const cell = grid.cells[r]![c]!;
          const key = `${grid.id} ${r} ${c}`;
          const keep = needed.get(key) ?? new Set<string>();
          keep.add(cell.states[cell.current]!.id);
          if (keep.size >= cell.states.length) continue;
          const currentId = cell.states[cell.current]!.id;
          cell.states = cell.states.filter((s) => keep.has(s.id));
          cell.current = cell.states.findIndex((s) => s.id === currentId);
        }
      }
    }
  }
}
