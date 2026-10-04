# commission-settlement

多层推荐佣金月结库（TypeScript + SQLite）。上层直接调用，组织关系、月 PV、
结算进度与最终结果全部持久化在 SQLite 中，进程可随时退出并在重开后继续。

## 环境要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无任何原生/外部依赖）
  - Node 22.5 ~ 23.3 需要 `node --experimental-sqlite` 标志
  - Node >= 23.4（含 24 LTS）开箱即用
- `npm install` 只安装 devDependency `typescript`，用于编译

## 使用

```bash
npm install
npm test        # 编译并运行全部测试（含 10 万成员规模测试）
npm run build   # 仅编译到 dist/
```

```ts
import { CommissionSettlement } from "commission-settlement";

const api = new CommissionSettlement("./data.sqlite");

// 1. 录入（月结进行中也可继续录入，不影响已受理批次）
api.upsertMember("alice", null);        // 新增成员 / 修改推荐人
api.upsertMember("bob", "alice");
api.setMonthlyPv("bob", "2026-09", 1200); // 覆盖指定月份 PV，0~99999 整数

// 2. 发起月结：固定当时的成员、推荐关系与该月 PV；同月重复发起返回原批次
const batch = api.initiateSettlement("2026-09");

// 3. 分批推进：每次最多结算 200 名成员，可在任意时刻中断/退出/继续录入
let info = api.advanceSettlement("2026-09");        // 默认 200
info = api.advanceSettlement("2026-09", 50);        // 也可更小步长

// 4. 查询
const status = api.getSettlementStatus("2026-09");  // 处理中：仅状态与完成人数
// 处理中 getMemberResult / getAllResults 均返回 null，读不到部分佣金
if (status && status.status === "completed") {
  const r = api.getMemberResult("2026-09", "alice"); // { commissionCents, needsReview }
  const all = api.getAllResults("2026-09");          // 全月结果一次性可见
}

api.close();
```

## 规则要点

- 佣金只来自下线 PV（1 PV = 1 美元，自身 PV 不计），以美分整数精确计账：
  第 1 层 5%，第 2 层 3%，第 3~5 层 2%，第 6~12 层 1%，超过 12 层不计。
- 每个成员（含零佣金）都有月结记录；佣金 > 2500 美元标记 `needsReview`
  （恰好 2500 不标记），标记不截断佣金。
- 发起月结即冻结输入快照（`batch_members` / `batch_edges` / `batch_pv`），
  之后的录入修改只影响下一个月份。
- 同一个月份全局唯一批次（`batches.month` 唯一约束），重复发起幂等返回原批次。
- 每次推进在一个事务内完成至多 200 名成员并持久化进度：崩溃后完成人数
  不倒退、任何成员不重复入账；全部完成后结果永久不变。

## 项目结构

- `src/types.ts` — 公共类型与费率常量
- `src/db.ts` — SQLite 打开与建表（WAL 模式）
- `src/input.ts` — 成员/推荐关系与月 PV 录入
- `src/settlement.ts` — 发起、分批推进、查询（含冻结快照的进程内缓存）
- `src/index.ts` — `CommissionSettlement` 门面
- `src/node-shims.d.ts` — 所用 Node 内置模块的最小类型声明（免装 @types/node）
- `test/` — node:test 测试；`test/helpers.ts` 内含独立参考实现用于对账
