import { assert, test } from "./harness";
import { PixelGridUndoEngine } from "../src/engine";

function makeEngine(
  grids: string[] = ["g"],
  rows = 1,
  cols = 2,
): PixelGridUndoEngine<number> {
  return new PixelGridUndoEngine<number>({
    grids,
    rows,
    cols,
    initialValue: 0,
  });
}

function cell(
  engine: PixelGridUndoEngine<number>,
  grid: string,
  row: number,
  col: number,
): number {
  return engine.inspect().cells[grid]![row]![col]!;
}

test("two sessions edit different columns of the same row, both undo independently", () => {
  const engine = makeEngine();
  const op1 = engine.edit("s1", [{ addr: { grid: "g", row: 0, col: 0 }, value: 1 }]);
  const op2 = engine.edit("s2", [{ addr: { grid: "g", row: 0, col: 1 }, value: 2 }]);
  assert.notEqual(op1, op2);

  const undo1 = engine.undo("s1");
  assert.deepEqual(undo1, { ok: true, opId: op1 });
  assert.equal(cell(engine, "g", 0, 0), 0);
  assert.equal(cell(engine, "g", 0, 1), 2);

  const undo2 = engine.undo("s2");
  assert.deepEqual(undo2, { ok: true, opId: op2 });
  assert.equal(cell(engine, "g", 0, 0), 0);
  assert.equal(cell(engine, "g", 0, 1), 0);

  // row version: two edits + two undos on the same row
  assert.equal(engine.inspect().rows["g/0"]!.version, 4);
});

test("same value rewritten by another session still blocks undo until both later edits are undone", () => {
  const engine = makeEngine();
  engine.edit("s1", [{ addr: { grid: "g", row: 0, col: 0 }, value: 1 }]);
  engine.edit("s2", [{ addr: { grid: "g", row: 0, col: 0 }, value: 2 }]);
  engine.edit("s2", [{ addr: { grid: "g", row: 0, col: 0 }, value: 1 }]); // same value as s1's edit

  assert.deepEqual(engine.undo("s1"), { ok: false });
  assert.equal(cell(engine, "g", 0, 0), 1);

  assert.equal(engine.undo("s2").ok, true); // undoes value 1 -> 2
  assert.deepEqual(engine.undo("s1"), { ok: false }); // still blocked by first s2 edit
  assert.equal(engine.undo("s2").ok, true); // undoes value 2 -> 1
  assert.equal(cell(engine, "g", 0, 0), 1);

  const restored = engine.undo("s1");
  assert.equal(restored.ok, true);
  assert.equal(cell(engine, "g", 0, 0), 0);
});

test("redo requires the pre-edit identity, equal value is not enough", () => {
  const engine = makeEngine();
  engine.edit("s1", [{ addr: { grid: "g", row: 0, col: 0 }, value: 1 }]);
  assert.equal(engine.undo("s1").ok, true);
  engine.edit("s2", [{ addr: { grid: "g", row: 0, col: 0 }, value: 0 }]); // same value as current
  assert.deepEqual(engine.redo("s1"), { ok: false });
  assert.equal(cell(engine, "g", 0, 0), 0);
});

test("cross-row batch blocked on one cell fails atomically, then undo/redo chains work", () => {
  const engine = makeEngine(["g"], 2, 1);
  const b1 = engine.edit("s1", [
    { addr: { grid: "g", row: 0, col: 0 }, value: 1 },
    { addr: { grid: "g", row: 1, col: 0 }, value: 1 },
  ]);
  const b2 = engine.edit("s1", [
    { addr: { grid: "g", row: 0, col: 0 }, value: 2 },
    { addr: { grid: "g", row: 1, col: 0 }, value: 2 },
  ]);
  engine.edit("s2", [{ addr: { grid: "g", row: 1, col: 0 }, value: 9 }]);

  const before = engine.inspect();
  assert.deepEqual(engine.undo("s1"), { ok: false });
  const after = engine.inspect();
  // failed undo changed nothing: values, row versions, session history
  assert.deepEqual(after.cells, before.cells);
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.sessions, before.sessions);
  assert.deepEqual(after.sessions["s1"]!.undoable, [b1, b2]);

  assert.equal(engine.undo("s2").ok, true); // remove the blocker
  assert.equal(cell(engine, "g", 1, 0), 2);

  assert.equal(engine.undo("s1").ok, true); // undo b2
  assert.equal(cell(engine, "g", 0, 0), 1);
  assert.equal(cell(engine, "g", 1, 0), 1);
  assert.equal(engine.undo("s1").ok, true); // undo b1
  assert.equal(cell(engine, "g", 0, 0), 0);
  assert.equal(cell(engine, "g", 1, 0), 0);

  assert.equal(engine.redo("s1").ok, true); // redo b1
  assert.equal(cell(engine, "g", 0, 0), 1);
  assert.equal(cell(engine, "g", 1, 0), 1);
  assert.equal(engine.redo("s1").ok, true); // redo b2
  assert.equal(cell(engine, "g", 0, 0), 2);
  assert.equal(cell(engine, "g", 1, 0), 2);
  assert.deepEqual(engine.redo("s1"), { ok: false });
});

test("55 edits on one cell: snapshots capped at 20, last 50 undoable, redo to final value", () => {
  const engine = makeEngine();
  for (let i = 1; i <= 55; i += 1) {
    engine.edit("s1", [{ addr: { grid: "g", row: 0, col: 0 }, value: i }]);
  }
  let view = engine.inspect();
  assert.equal(view.rows["g/0"]!.snapshots.length, 20);
  assert.equal(view.rows["g/0"]!.version, 55);
  assert.equal(view.sessions["s1"]!.undoable.length, 50);

  for (let i = 0; i < 50; i += 1) {
    assert.equal(engine.undo("s1").ok, true);
  }
  assert.equal(cell(engine, "g", 0, 0), 5); // edits 6..55 undone, edit #5 evicted but its effect stays
  assert.deepEqual(engine.undo("s1"), { ok: false });

  for (let i = 0; i < 50; i += 1) {
    assert.equal(engine.redo("s1").ok, true);
  }
  assert.equal(cell(engine, "g", 0, 0), 55);
  view = engine.inspect();
  assert.equal(view.rows["g/0"]!.snapshots.length, 20);
});

test("new edit clears only this session's redo branch; evicted ops keep their effects", () => {
  const engine = makeEngine();
  for (let i = 1; i <= 55; i += 1) {
    engine.edit("s1", [{ addr: { grid: "g", row: 0, col: 0 }, value: i }]);
  }
  engine.edit("s2", [{ addr: { grid: "g", row: 0, col: 1 }, value: 100 }]);
  engine.undo("s2"); // s2 now has a redo branch

  assert.equal(engine.undo("s1").ok, true);
  assert.equal(engine.undo("s1").ok, true);
  assert.equal(engine.inspect().sessions["s1"]!.redoable.length, 2);

  engine.edit("s1", [{ addr: { grid: "g", row: 0, col: 0 }, value: 999 }]);
  const view = engine.inspect();
  assert.deepEqual(view.sessions["s1"]!.redoable, []);
  assert.equal(view.sessions["s2"]!.redoable.length, 1); // s2's redo branch untouched
  assert.equal(cell(engine, "g", 0, 0), 999);
  assert.equal(cell(engine, "g", 0, 1), 0); // s2's edit was undone

  // evicted ops (edits 1..5) lost their entries but their effects remain:
  // undoing everything possible still leaves value 5-based history intact.
  assert.equal(engine.redo("s2").ok, true);
  assert.equal(cell(engine, "g", 0, 1), 100);
});

test("one op touching a row twice bumps its version once; multi-grid batch works", () => {
  const engine = makeEngine(["g1", "g2"], 1, 2);
  engine.edit("s1", [
    { addr: { grid: "g1", row: 0, col: 0 }, value: 1 },
    { addr: { grid: "g1", row: 0, col: 1 }, value: 2 },
    { addr: { grid: "g2", row: 0, col: 0 }, value: 3 },
  ]);
  const view = engine.inspect();
  assert.equal(view.rows["g1/0"]!.version, 1);
  assert.equal(view.rows["g2/0"]!.version, 1);
  assert.equal(view.rows["g1/0"]!.snapshots.length, 1);
  assert.deepEqual(view.rows["g1/0"]!.snapshots[0]!.values, [1, 2]);
  assert.deepEqual(view.rows["g2/0"]!.snapshots[0]!.values, [3, 0]);
});

test("inspect returns detached copies that cannot mutate internal state", () => {
  const engine = makeEngine();
  engine.edit("s1", [{ addr: { grid: "g", row: 0, col: 0 }, value: 1 }]);
  const view = engine.inspect();
  view.cells["g"]![0]![0] = 999;
  view.rows["g/0"]!.version = 999;
  view.rows["g/0"]!.snapshots[0]!.values[0] = 999;
  view.sessions["s1"]!.undoable.length = 0;

  const fresh = engine.inspect();
  assert.equal(fresh.cells["g"]![0]![0], 1);
  assert.equal(fresh.rows["g/0"]!.version, 1);
  assert.equal(fresh.rows["g/0"]!.snapshots[0]!.values[0], 1);
  assert.equal(fresh.sessions["s1"]!.undoable.length, 1);
});

test("undo/redo on unknown or exhausted sessions fail without side effects", () => {
  const engine = makeEngine();
  assert.deepEqual(engine.undo("nobody"), { ok: false });
  assert.deepEqual(engine.redo("nobody"), { ok: false });
  engine.edit("s1", [{ addr: { grid: "g", row: 0, col: 0 }, value: 1 }]);
  assert.deepEqual(engine.redo("s1"), { ok: false });
  assert.equal(engine.undo("s1").ok, true);
  assert.deepEqual(engine.undo("s1"), { ok: false });
  assert.equal(engine.inspect().rows["g/0"]!.version, 2);
});
