# task26100671

客户批量导入的模糊判重组件（纯进程内 TypeScript 库，调用串行，无持久化）。

## 用法

```ts
import { createImporter } from "./src/importer.js";

const importer = createImporter([{ id: 1, name: "alice" }]);
const results = importer.importBatch(["alicf", "bob"]);
// [
//   { kind: "duplicate", name: "alicf", matchedId: 1, distance: 1 },
//   { kind: "added", id: 2, name: "bob" },
// ]
```

- `createImporter(existing)`：由既有 `{ id, name }` 记录建库；id 为互异正整数，名字可重复。
- `importBatch(names)`：按输入顺序逐条处理。与库中某记录的单位代价
  Levenshtein 距离（插入/删除/替换各计 1，相邻交换不算）不超过 3 时跳过，
  返回距离最小记录的 id（距离相同取最小 id）；否则插入，id 取当前最大 id 加 1
  （空库从 1 开始）。本批新增的记录对后续行可见，被跳过的行不参与判重。

## 构建与测试

```sh
npm install
npm test
