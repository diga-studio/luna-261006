# identity-resolution

客户身份纠错与档案重组库（TypeScript，进程内存版）。由上层导入流程直接调用，无接口层。

## 使用

```ts
import { IdentityStore } from "identity-resolution";

const store = new IdentityStore();

// 批量提交来源记录快照（每批最多 5000 条；已有记录被完整替换）
store.submitBatch([
  { sourceId: "crm", recordId: "1", email: "u@x.com", tags: ["vip"], interactions: 3 },
  { sourceId: "web", recordId: "anon-9", tags: ["浏览过A"], interactions: 1 },
]);

// 匿名记录补齐标识后并入对应客户档案
store.submitBatch([
  { sourceId: "web", recordId: "anon-9", email: "u@x.com", tags: ["浏览过A"], interactions: 1 },
]);

// 通过任意来源记录键查询其当前所属统一档案
const profile = store.getProfileOf({ sourceId: "web", recordId: "anon-9" });
// => { profileId, members: Set<RecordKey>, tags: Set<string>, totalInteractions }
```

## 语义

- 记录由 `sourceId + recordId` 唯一标识；`email` / `externalId` 可缺省，缺省表示撤回该标识。
- 快照语义：重复提交相同快照不产生副作用（互动次数不累加）；批内顺序不影响结果。
- email 相同或 external_id 相同即属同一客户，跨 `sourceId` 生效且具有传递性；
  两个标识域互不相通；两个标识都缺省的记录各自独立。
- 每次提交后，统一档案恰好等于当前快照下匹配关系的连通分量：
  撤回/纠错标识后，无其他路径维系的档案立即拆开，旧标识不再参与匹配。
- 档案聚合：成员记录键集合、标签并集（按成员计数，失去部分支持不误删）、互动次数之和。

## 实现要点

- 内存结构：记录表 + email/external_id 倒排索引 + 记录键到档案的映射。
- 每次提交只重算受影响档案的闭包（以变更记录为起点，沿当前标识做档案级 BFS），
  在闭包内用并查集重建连通分量；按标识值去重后整桶展开，避免大档案下 O(n²)。
- 标识未变化的提交只增量更新档案聚合，不触发重算。

## 构建与测试. 

```sh
npm install
npm test        # 单元测试 + 规模测试（耗时与峰值内存会打印到控制台）
npm run test:unit   # 仅单元测试（含与独立重算对照的随机一致性测试）
npm run test:perf   # 仅规模测试
```

规模测试实测（Apple Silicon，Node 24）：

- 10 万条记录共享同一标识：分批导入约 1s（上限 15s）；单条改为无标识的拆分更新 + 两次查询约 0.1s（上限 5s）；峰值 RSS 约 330MiB（上限 512MiB）。
- 10 万条记录、档案不超过 20 条：5000 次单记录纠错且每次纠错后查询，合计约 0.12s（上限 5s）。
