# identity-resolution

客户身份纠错与档案重组库（TypeScript，进程内存存储，无接口层）。上层导入流程直接 `import` 调用。

## 环境要求

- Node.js >= 22.6（测试利用 Node 原生 TypeScript 类型擦除运行，无需额外转译器）
- `npm install` 仅需安装 `typescript`（用于 `npm run typecheck`）；`npm test` 本身零依赖

```bash
npm install
npm test        # 运行全部正确性与规模测试
npm run typecheck
```

## API

```ts
import { ProfileStore } from "identity-resolution";

const store = new ProfileStore();

// 批量提交来源记录快照（每批最多 5000 条，同批键不重复，批内顺序无关）
store.submitBatch([
  { sourceId: "web", recordId: "1", email: "a@x.com", tags: ["vip"], interactions: 3 },
  { sourceId: "crm", recordId: "c-1", externalId: "ext-9" }, // 标识可缺省
]);

// 通过任意来源记录键查询当前所属统一档案
const profile = store.getProfileByRecord("web", "1");
// => { profileId, members: [{sourceId, recordId}...], tags: [...], interactions: n } | undefined
```

## 语义

- 记录由 `sourceId + recordId` 唯一标识；再次提交同键快照即**完整替换**（标签与互动次数是现值，缺省标识表示撤回）。
- `email` 相同或 `externalId` 相同即属同一客户，跨 `sourceId` 生效且具有传递性；两个标识域互不相通；双标识缺省的记录各自独立。
- 每次提交后，统一档案恰好对应当前快照的连通群：撤回/纠错标识后，无其他路径维系的旧档案拆开，仍有其他路径的保持合并；旧标识不再参与匹配。
- 档案返回成员记录键集合、标签并集（按成员引用计数维护，失去一个成员不会误删仍被支持的标签）、互动次数之和（每条记录只贡献一次）。
- 重复提交相同快照幂等；匿名记录补齐标识后，其标签与互动跟随该记录归属。

## 实现要点

- 存储：记录表 + `email`/`externalId` 两个标识索引（标识 -> 记录键集合）+ 档案表（成员集合、标签引用计数、互动总和）。
- 提交时先校验（批量上限、批内键重复、互动次数合法），再应用快照替换并收集脏记录键（含被撤回标识的旧同组记录），最后在“记录 <-> 标识”二部图上对脏记录所在连通群做整体重算。每个标识节点的成员组在一次重算中至多展开一次，10 万条共享同一标识的档案也能在线性时间内完成合并与拆分。

## 规模测试实测（本机，Node 24）

| 场景 | 耗时 | 峰值内存 |
| --- | --- | --- |
| 10 万条共享同一标识，20 批首次导入 | ~1.5 s（上限 15 s） | < 512 MiB |
| 单条撤回标识 + 查询拆分后两个档案 | ~0.2 s（上限 5 s） | 全程峰值 < 450 MiB |
| 10 万条/档案 ≤ 20 条，5000 次单记录纠错 + 逐次查询 | ~0.15 s（上限 5 s） | 同上 |

正确性测试另含随机小规模序列对照：每次提交后与仅依据当前快照独立重算的结果逐一比对（`test/fuzz.test.ts`）。
