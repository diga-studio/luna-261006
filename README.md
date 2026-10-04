# mindmap-batch-edit

思维导图批量编辑库：由上层直接调用，导图数据持久化在 SQLite。

## 环境要求

- Node.js >= 23.4（使用内置 `node:sqlite`，无需任何原生依赖或外部服务）
- `npm install && npm test` 即可运行全部自动化测试

## 能力

```ts
import { MindMapService } from './dist/src/mindmap.js';

const service = new MindMapService('path/to/maps.db'); // ':memory:' 表示纯内存

// 1. 初始化导图：输入保证是合法有序树，返回初始版本 1
const version = service.initMap('map-1', {
  id: 'R',
  children: [{ id: 'A' }, { id: 'B', children: [{ id: 'C' }] }],
});

// 2. 读取导图及版本：返回一个完整的已提交版本快照
const snapshot = service.readMap('map-1');
// { mapId, version, rootId, parents: {id -> parentId|null}, children: {id -> [childId...]} }

// 3. 提交批量编辑：仅当 baseVersion 仍是当前版本时才生效，成功后版本恰好 +1
const result = service.submitBatch('map-1', snapshot.version, [
  { nodeId: 'C', newParentId: 'R', position: 0 },
  { nodeId: 'A', newParentId: 'C', position: 0 },
]);
// { ok: true, version: 2 } 或 { ok: false, reason: '...' }
```

## 批量语义

- 每批最多 50 个不同节点；每项指定新父节点及最终孩子列表中的位置（从 0 开始）。
- 整批同时表达目标状态，结果与批内操作排列无关；合法性只取决于最终树。
- 对每个父节点，指定到它的编辑各自占据互不重复且介于 `0..k-1` 的最终位置
  （k 为最终孩子总数），其余孩子按编辑前相对顺序填满剩余位置。
- 最终树必须连通、无环、所有节点深度不超过 12（含被搬节点下未单独搬离的后代）。
- 任何一项不合法或版本过期：整批拒绝，父子关系、顺序、版本全部保持原样。
- 同版本竞争提交：恰好一个成功，其余返回 `version_conflict`。

## 结构

- `src/types.ts` — 对外类型定义
- `src/batch.ts` — 批量校验与目标状态计算（纯函数，不落盘）
- `src/store.ts` — SQLite 持久化（`maps` / `nodes` / `children` 三表；
  孩子顺序按父节点存 JSON 行，大孩子列表重排只重写一行）
- `src/mindmap.ts` — 门面：内存缓存 + 版本检查 + 事务提交
- `test/` — node:test 自动化测试（业务规则、竞争、失败回滚、性能）

## 性能

单图 10 万节点、单父节点 5 万孩子的场景下，连续 200 批 × 50 项编辑，
本机实测批次耗时 p95 约 43ms（指标要求 <= 500ms，完整读图不计入）。
