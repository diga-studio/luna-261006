# PixelGrid 会话级撤销引擎

TypeScript 实现的内存库，为多会话共享的 PixelGrid 提供会话级 undo/redo。

## 使用

```ts
import { PixelGridUndoEngine } from './src';

const engine = new PixelGridUndoEngine([
  { id: 'grid-1', rows: 10, cols: 10, initial: 0 },
]);

const { opId } = engine.edit('session-A', [
  { grid: 'grid-1', row: 0, col: 0, value: 'red' },
  { grid: 'grid-1', row: 1, col: 1, value: 'blue' },
]);

engine.undo('session-A'); // { ok: true, opId } 或 { ok: false, reason: 'empty' | 'conflict' }
engine.redo('session-A');
const view = engine.inspect(); // 深拷贝快照：当前值、行版本、行快照、各会话可撤销/重做操作
```

## 核心规则

- 编辑状态 = 值 + 来源操作；写入相同值也是新编辑。
- undo 仅当目标操作是每个目标单元格上最近的生效编辑时成功；redo 要求每个目标单元格处于该操作首次执行前的编辑状态（按身份而非值判断）。
- undo/redo 原子执行：任一单元格受阻则整体失败，不改变任何值、行版本或历史。
- 每会话最多保留 50 个可撤销/可重做操作，超额按首次 edit 顺序淘汰（不取消其效果）；新 edit 只清除本会话的 redo 分支。
- 每次成功的 edit/undo/redo 对触及的每行产生一个递增版本；每行最多保留 20 份提交后快照。

## 构建与测试

```sh
npm install
npm test
```
