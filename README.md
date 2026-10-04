# PixelGrid Undo Engine

会话级撤销/重做内存库（TypeScript）。结构（网格、行、列）在构造时固定，之后只通过 `edit` / `undo` / `redo` 修改单元格。

## 使用

```bash
npm install
npm test        # tsc 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

```ts
import { PixelGridUndoEngine } from "./src/engine";

const engine = new PixelGridUndoEngine<number>({
  grids: ["main"],
  rows: 4,
  cols: 4,
  initialValue: 0,
});

const opId = engine.edit("session-a", [
  { addr: { grid: "main", row: 0, col: 0 }, value: 1 },
  { addr: { grid: "main", row: 1, col: 2 }, value: 2 },
]);

engine.undo("session-a"); // { ok: true, opId } 或 { ok: false }（冲突/无操作）
engine.redo("session-a");

const view = engine.inspect(); // 深拷贝快照：cells / rows(版本+快照) / sessions(可撤销、可重做)
```

## 语义要点

- 每个单元格记录「值 + 编辑身份(stateId)」；写入相同值也是新编辑。
- `undo` 仅当目标操作对每个目标单元格都是最近的生效编辑时成功；`redo` 要求每个目标单元格都处于该操作首次执行前的编辑状态（仅值相等不够）。
- 冲突时整个操作原子失败：不改任何值、行版本或历史。
- 每会话最多保留 50 个逻辑操作，新 `edit` 清除本会话 redo 分支，超额按首次 edit 顺序淘汰最旧操作（效果保留）。
- 每次成功的 edit/undo/redo 对触及的每行只产生一个递增版本；每行仅保留最近 20 个提交后快照。
