import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PixelGridUndoEngine } from '../src/index';

const GRID = 'g1';

function makeEngine(rows = 2, cols = 3, initial: unknown = 0) {
  return new PixelGridUndoEngine([
    { id: GRID, rows, cols, initial },
  ]);
}

function cellValue(engine: PixelGridUndoEngine, row: number, col: number, grid = GRID) {
  const view = engine.inspect();
  const g = view.grids.find((x) => x.id === grid)!;
  return g.values[row]![col];
}

function rowVersion(engine: PixelGridUndoEngine, row: number, grid = GRID) {
  const view = engine.inspect();
  return view.grids.find((x) => x.id === grid)!.rowVersions[row]!;
}

test('两个会话修改同一行不同列，各自能独立撤销', () => {
  const engine = makeEngine(1, 3, 0);
  const a1 = engine.edit('A', [{ grid: GRID, row: 0, col: 0, value: 'a1' }]);
  const b1 = engine.edit('B', [{ grid: GRID, row: 0, col: 1, value: 'b1' }]);
  assert.equal(a1.ok, true);
  assert.equal(b1.ok, true);

  // B 先撤销自己的列，不影响 A 的列
  const ub = engine.undo('B');
  assert.deepEqual(ub, { ok: true, opId: b1.opId });
  assert.equal(cellValue(engine, 0, 0), 'a1');
  assert.equal(cellValue(engine, 0, 1), 0);

  // A 的列未被 B 的撤销覆盖，且 A 仍能撤销
  const ua = engine.undo('A');
  assert.deepEqual(ua, { ok: true, opId: a1.opId });
  assert.equal(cellValue(engine, 0, 0), 0);
  assert.equal(cellValue(engine, 0, 1), 0);

  // 行版本：两次 edit + 两次 undo，共 4 次递增
  assert.equal(rowVersion(engine, 0), 4);
});

test('同格被改走再改回相同值，原操作仍不能撤销，直到后来两次编辑均被撤销', () => {
  const engine = makeEngine(1, 1, 0);
  const a1 = engine.edit('A', [{ grid: GRID, row: 0, col: 0, value: 'x' }]);
  // 另一会话改走，再改回相同值（写入相同值也算新编辑）
  engine.edit('B', [{ grid: GRID, row: 0, col: 0, value: 'y' }]);
  const b2 = engine.edit('B', [{ grid: GRID, row: 0, col: 0, value: 'x' }]);
  assert.equal(b2.ok, true);
  assert.equal(cellValue(engine, 0, 0), 'x');

  // 值虽相同，但当前编辑状态来源已变，A 的操作不能撤销
  assert.deepEqual(engine.undo('A'), { ok: false, reason: 'conflict' });
  assert.equal(cellValue(engine, 0, 0), 'x');

  // 撤销 B 的第二次编辑（改回 x 的那次）
  assert.equal(engine.undo('B').ok, true);
  assert.equal(cellValue(engine, 0, 0), 'y');
  // 仍被 B 的第一次编辑阻挡
  assert.deepEqual(engine.undo('A'), { ok: false, reason: 'conflict' });

  // 撤销 B 的第一次编辑后，A 的操作恢复为最近生效编辑，可撤销
  assert.equal(engine.undo('B').ok, true);
  assert.equal(cellValue(engine, 0, 0), 'x');
  assert.deepEqual(engine.undo('A'), { ok: true, opId: a1.opId });
  assert.equal(cellValue(engine, 0, 0), 0);

  // 撤销不新增逻辑操作：A 此时只有 1 个可重做操作
  const view = engine.inspect();
  const sa = view.sessions.find((s) => s.id === 'A')!;
  const sb = view.sessions.find((s) => s.id === 'B')!;
  assert.deepEqual(sa.undoable, []);
  assert.deepEqual(sa.redoable, [a1.opId]);
  assert.equal(sb.undoable.length, 0);
  assert.equal(sb.redoable.length, 2);
});

test('跨行批次一格受阻则 undo 整体失败且无副作用；解除阻挡后可撤销', () => {
  const engine = makeEngine(2, 2, 0);
  const a1 = engine.edit('A', [
    { grid: GRID, row: 0, col: 0, value: 'a0' },
    { grid: GRID, row: 1, col: 0, value: 'a1' },
  ]);
  engine.edit('B', [{ grid: GRID, row: 0, col: 0, value: 'b0' }]);

  const before = engine.inspect();
  // (1,0) 满足条件但 (0,0) 被 B 阻挡：整体失败
  assert.deepEqual(engine.undo('A'), { ok: false, reason: 'conflict' });
  const after = engine.inspect();
  // 所有值、行版本、会话历史均不变
  assert.deepEqual(after, before);
  assert.equal(cellValue(engine, 0, 0), 'b0');
  assert.equal(cellValue(engine, 1, 0), 'a1');
  assert.deepEqual([rowVersion(engine, 0), rowVersion(engine, 1)], [2, 1]);

  // 解除阻挡后，同一批次可整体撤销
  assert.equal(engine.undo('B').ok, true);
  assert.deepEqual(engine.undo('A'), { ok: true, opId: a1.opId });
  assert.equal(cellValue(engine, 0, 0), 0);
  assert.equal(cellValue(engine, 1, 0), 0);
  assert.deepEqual([rowVersion(engine, 0), rowVersion(engine, 1)], [4, 2]);
});

test('连续多个覆盖同一格的批次：连续 undo 再按顺序 redo 得到正确结果', () => {
  const engine = makeEngine(2, 2, 0);
  engine.edit('C', [
    { grid: GRID, row: 0, col: 0, value: 'c1' },
    { grid: GRID, row: 0, col: 1, value: 'x1' },
  ]);
  engine.edit('C', [
    { grid: GRID, row: 0, col: 0, value: 'c2' },
    { grid: GRID, row: 1, col: 1, value: 'y1' },
  ]);
  engine.edit('C', [{ grid: GRID, row: 0, col: 0, value: 'c3' }]);

  // 连续撤销三个批次
  assert.equal(engine.undo('C').ok, true);
  assert.deepEqual(
    [cellValue(engine, 0, 0), cellValue(engine, 0, 1), cellValue(engine, 1, 1)],
    ['c2', 'x1', 'y1'],
  );
  assert.equal(engine.undo('C').ok, true);
  assert.deepEqual(
    [cellValue(engine, 0, 0), cellValue(engine, 0, 1), cellValue(engine, 1, 1)],
    ['c1', 'x1', 0],
  );
  assert.equal(engine.undo('C').ok, true);
  assert.deepEqual(
    [cellValue(engine, 0, 0), cellValue(engine, 0, 1), cellValue(engine, 1, 1)],
    [0, 0, 0],
  );
  assert.deepEqual(engine.undo('C'), { ok: false, reason: 'empty' });

  // 按顺序重做恢复逻辑身份与值
  assert.equal(engine.redo('C').ok, true);
  assert.equal(cellValue(engine, 0, 0), 'c1');
  assert.equal(cellValue(engine, 0, 1), 'x1');
  assert.equal(engine.redo('C').ok, true);
  assert.equal(cellValue(engine, 0, 0), 'c2');
  assert.equal(cellValue(engine, 1, 1), 'y1');
  assert.equal(engine.redo('C').ok, true);
  assert.equal(cellValue(engine, 0, 0), 'c3');
  assert.deepEqual(engine.redo('C'), { ok: false, reason: 'empty' });

  // 行版本：row0 经历 3 edit + 3 undo + 3 redo；row1 只被第二批触及（1+1+1）
  assert.equal(rowVersion(engine, 0), 9);
  assert.equal(rowVersion(engine, 1), 3);
});

test('55+ 次连续编辑：快照≤20、可撤销最近50次并重做；redo 分支按会话隔离；淘汰不取消效果', () => {
  const engine = makeEngine(2, 2, 0);
  // 先在 (0,1) 制造 5 次将被淘汰的编辑
  for (let i = 1; i <= 5; i++) {
    engine.edit('S', [{ grid: GRID, row: 0, col: 1, value: `e${i}` }]);
  }
  // 再对 (0,0) 连续编辑 55 次，共 60 个操作，窗口只留 50
  for (let i = 1; i <= 55; i++) {
    engine.edit('S', [{ grid: GRID, row: 0, col: 0, value: i }]);
  }

  let view = engine.inspect();
  const s0 = view.sessions.find((s) => s.id === 'S')!;
  assert.equal(s0.undoable.length, 50);
  assert.equal(s0.redoable.length, 0);
  // 行快照始终不超过 20 份
  assert.equal(view.grids[0]!.rowSnapshots[0]!.length, 20);
  assert.equal(rowVersion(engine, 0), 60);
  // 被淘汰操作的效果没有消失
  assert.equal(cellValue(engine, 0, 1), 'e5');
  assert.equal(cellValue(engine, 0, 0), 55);

  // 撤销最近 50 次：(0,0) 回到第 5 次编辑的值（更早的已被淘汰，不可撤销）
  for (let i = 0; i < 50; i++) {
    assert.equal(engine.undo('S').ok, true, `undo #${i + 1}`);
  }
  assert.equal(cellValue(engine, 0, 0), 5);
  assert.deepEqual(engine.undo('S'), { ok: false, reason: 'empty' });
  // 快照裁剪不影响窗口内操作：撤销过程中快照仍 ≤20
  view = engine.inspect();
  assert.ok(view.grids[0]!.rowSnapshots[0]!.length <= 20);

  // 重做到最终值
  for (let i = 0; i < 50; i++) {
    assert.equal(engine.redo('S').ok, true, `redo #${i + 1}`);
  }
  assert.equal(cellValue(engine, 0, 0), 55);
  assert.deepEqual(engine.redo('S'), { ok: false, reason: 'empty' });

  // 制造 redo 分支：S 撤销 3 次；T 编辑另一格再撤销，T 也有 redo 分支
  for (let i = 0; i < 3; i++) assert.equal(engine.undo('S').ok, true);
  engine.edit('T', [{ grid: GRID, row: 1, col: 0, value: 't1' }]);
  assert.equal(engine.undo('T').ok, true);

  // S 的新 edit 只清除 S 的 redo 分支
  engine.edit('S', [{ grid: GRID, row: 0, col: 0, value: 'new' }]);
  view = engine.inspect();
  const s1 = view.sessions.find((s) => s.id === 'S')!;
  const t1 = view.sessions.find((s) => s.id === 'T')!;
  assert.equal(s1.redoable.length, 0);
  assert.equal(t1.redoable.length, 1);
  assert.equal(cellValue(engine, 0, 0), 'new');
  // T 的 redo 仍可用
  assert.equal(engine.redo('T').ok, true);
  assert.equal(cellValue(engine, 1, 0), 't1');
});

test('inspect 返回深拷贝，调用者无法借此修改内部状态', () => {
  const engine = makeEngine(1, 2, { n: 0 });
  engine.edit('A', [{ grid: GRID, row: 0, col: 0, value: { n: 1 } }]);
  const view = engine.inspect();
  // 篡改返回对象
  (view.grids[0]!.values[0]![0] as { n: number }).n = 999;
  view.grids[0]!.rowVersions[0] = 999;
  view.grids[0]!.rowSnapshots[0]![0]!.values[0] = 'hacked';
  view.sessions[0]!.undoable.length = 0;

  const fresh = engine.inspect();
  assert.deepEqual(fresh.grids[0]!.values[0]![0], { n: 1 });
  assert.equal(fresh.grids[0]!.rowVersions[0], 1);
  assert.deepEqual(fresh.grids[0]!.rowSnapshots[0]![0]!.values[0], { n: 1 });
  assert.equal(fresh.sessions[0]!.undoable.length, 1);
  // undo 仍正常工作
  assert.equal(engine.undo('A').ok, true);
  assert.deepEqual(engine.inspect().grids[0]!.values[0]![0], { n: 0 });
});

test('一次 edit 可跨多个网格，undo 整体回退', () => {
  const engine = new PixelGridUndoEngine([
    { id: 'g1', rows: 1, cols: 1, initial: 0 },
    { id: 'g2', rows: 1, cols: 1, initial: 0 },
  ]);
  const op = engine.edit('A', [
    { grid: 'g1', row: 0, col: 0, value: 'x' },
    { grid: 'g2', row: 0, col: 0, value: 'y' },
  ]);
  assert.equal(op.ok, true);
  assert.equal(cellValue(engine, 0, 0, 'g1'), 'x');
  assert.equal(cellValue(engine, 0, 0, 'g2'), 'y');
  assert.deepEqual(engine.undo('A'), { ok: true, opId: op.opId });
  assert.equal(cellValue(engine, 0, 0, 'g1'), 0);
  assert.equal(cellValue(engine, 0, 0, 'g2'), 0);
  // 每个网格的行版本各自只递增 2 次（edit + undo）
  assert.equal(rowVersion(engine, 0, 'g1'), 2);
  assert.equal(rowVersion(engine, 0, 'g2'), 2);
});

test('写入相同值也算一次新编辑，可逐次撤销', () => {
  const engine = makeEngine(1, 1, 0);
  engine.edit('A', [{ grid: GRID, row: 0, col: 0, value: 'v' }]);
  engine.edit('A', [{ grid: GRID, row: 0, col: 0, value: 'v' }]);
  const view = engine.inspect();
  assert.equal(view.sessions[0]!.undoable.length, 2);
  assert.equal(engine.undo('A').ok, true);
  assert.equal(cellValue(engine, 0, 0), 'v');
  assert.equal(engine.undo('A').ok, true);
  assert.equal(cellValue(engine, 0, 0), 0);
  assert.equal(rowVersion(engine, 0), 4);
});

test('redo 冲突时整体失败且无副作用', () => {
  const engine = makeEngine(1, 1, 0);
  engine.edit('A', [{ grid: GRID, row: 0, col: 0, value: 'a' }]);
  assert.equal(engine.undo('A').ok, true);
  // 另一会话在同一格写入，使 redo 的前置编辑状态不再成立
  engine.edit('B', [{ grid: GRID, row: 0, col: 0, value: 'b' }]);
  const before = engine.inspect();
  assert.deepEqual(engine.redo('A'), { ok: false, reason: 'conflict' });
  assert.deepEqual(engine.inspect(), before);
  assert.equal(cellValue(engine, 0, 0), 'b');
  // A 的 redo 分支未被消费
  assert.equal(engine.inspect().sessions.find((s) => s.id === 'A')!.redoable.length, 1);
});
