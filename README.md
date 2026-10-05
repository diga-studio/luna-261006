# sqlite-canary-migrator

面向本地数据库工作台的 SQLite 金丝雀迁移协调库：先把同一份迁移应用到样板库（金丝雀），确认成功后再按顺序推广到其余项目库；任一库失败即撤回整批。进程在任意时刻被杀，重新打开后继续推进即可收敛。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无运行时依赖）

## 使用

```ts
import { CanaryMigrator } from "sqlite-canary-migrator";

const m = new CanaryMigrator("/path/to/state.sqlite"); // 协调器状态库（独立文件）

m.submit({
  id: "add-code-column",        // 稳定标识；同标识重复提交返回原批次
  dbs: ["canary.db", "p1.db"],  // 1..20 个有序不重复的库，第一个是金丝雀
  startVersion: 7,              // 各库当前 user_version，目标版本为 8
  sql: "ALTER TABLE items ADD COLUMN code TEXT; UPDATE items SET qty = qty + 1;",
});

m.advance("add-code-column");          // 推进到终态（success / failed）
const p = m.query("add-code-column");  // publishing | rolling_back | success | failed + 每库状态
```

进程被杀后：重新 `new CanaryMigrator(statePath)` 并再次 `advance(id)`，自动从断点继续——已发布的库不会重做，撤回会从剩余的库继续。

## 崩溃安全协议

- 每个库：先整库快照（临时文件 + fsync + 原子 rename）并落盘 `backed_up`，再在**单事务**内执行迁移 SQL + `foreign_key_check` + `user_version + 1`，提交后落盘 `migrated`。
- “事务已提交但状态未记录”的崩溃窗口：恢复时用 `user_version` 识别真实提交结果——已是目标版本则只补记状态，绝不重跑非幂等 SQL。
- 任一库失败 → 整批撤回：已提交的库用快照原子替换恢复（数据、结构、自增进度、版本全部回到提交前），全部还原后落盘 `failed`。
- 终态（`success` / `failed`）一旦写入不可变；旧批次重试是空操作，不会触碰任何库文件。

## 开发

```sh
npm install
npm test     # 编译并运行全部测试
npm run build
```

测试通过 `AdvanceHooks.atPoint` 在各个持久化边界注入模拟崩溃，覆盖：单库已提交未确认、全部提交未确认终态、撤回中途被杀、恢复期间再次被杀、累计加值迁移只生效一次、旧批次重试不覆盖新批次等场景。
