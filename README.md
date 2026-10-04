# mindmap-batch-edit

思维导图批量编辑库（TypeScript），由上层直接调用，导图数据持久化到 SQLite（使用 Node.js 内置 `node:sqlite`，无任何原生依赖与外部服务）。

## 能力

- `initMap(mapId, root)`：初始化导图，输入保证是一棵合法有序树，初始版本为 1。
- `getMap(mapId)`：读取导图及版本，始终返回一个完整的已提交版本。
- `submitBatch(mapId, { baseVersion, edits })`：提交批量编辑，整批原子生效或整批拒绝；仅当 `baseVersion` 仍是当前版本时允许提交，成功后版本恰好 +1。

## 业务规则要点

- 每批最多 50 个不同节点；每项指定新父节点与最终孩子列表中的位置（从 0 开始）。
- 整批同时表达目标状态：未被指定的节点保留原父节点；结果与批内操作排列无关。
- 对每个父节点，指定位置互不重复且介于 0 到 k-1（k 为最终孩子总数），其余孩子按编辑前相对顺序填满剩余位置。
- 最终必须仍是连通、无环、深度不超过 12 层的树（含搬迁节点下未搬离的全部后代）。
- 任何一项不合法或版本过期：整张图的关系、顺序与版本保持原样。

## 使用

```ts
import { MindMapLibrary } from 'mindmap-batch-edit';

const lib = new MindMapLibrary('maps.db');
await lib.initMap('m1', { id: 'R', children: [{ id: 'A' }, { id: 'B' }] });
const { version, root } = await lib.getMap('m1');
await lib.submitBatch('m1', {
  baseVersion: version,
  edits: [{ nodeId: 'B', newParentId: 'A', position: 0 }],
});
await lib.close();
```

错误类型：`VersionConflictError`（版本冲突）、`BatchValidationError`（批不合法，含 `reason`）、`MapNotFoundError`、`MapAlreadyExistsError`。

## 构建与测试

```sh
npm install
npm test
```

测试覆盖：批内排列无关性、最终孩子列表计算、重复位置/越界/成环/超深整批拒绝、50 个同版本批次竞争恰好一个成功、10 万节点连续 200 批编辑 p95 ≤ 500ms 且不变量保持。
