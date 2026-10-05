# fuzzy-dedup-importer

进程内的客户批量导入模糊判重库（TypeScript）。调用串行，不做持久化。

## 用法

```ts
import { createImporter } from "fuzzy-dedup-importer";

const importer = createImporter([
  { id: 7, name: "alice" },
  { id: 3, name: "bob" },
]);

const results = importer.importBatch(["alic", "charlie"]);
// [
//   { kind: "duplicate", id: 7, name: "alic", distance: 1 },
//   { kind: "inserted",  id: 8, name: "charlie" },
// ]
```

- `createImporter(existing)`：由已有 `{ id, name }` 记录建立导入器。`id` 为互异正整数，名字允许重复。
- `importBatch(names)`：按输入顺序逐条处理。若当前库中存在单位代价
  Levenshtein 距离 ≤ 3 的名字，则跳过并返回距离最小的记录 `id`
  （距离相同取最小 `id`）；否则插入，`id` 取当前最大 `id` + 1（空库从 1 开始）。
- 每行都能看到本批此前真正新增的记录；被跳过的行不参与后续判重
  （相似关系不按传递闭包合并）。新增记录跨调用持续有效。
- 输入名字视为已规范化，库不会改动其内容。

## 构建与测试

```sh
npm install
npm test
```

测试使用 Node.js 内置 `node:test`，TypeScript 编译后运行，无其他运行时依赖。
