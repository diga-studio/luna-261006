# sqlite-canary-migration

SQLite 金丝雀迁移协调库，供本地数据库工作台直接调用。同一迁移先发布到第一个
（金丝雀）库，确认成功后再按顺序推广到其余项目库；任一库失败则整批撤回。

## 要求

- Node.js >= 22.13（使用内置 `node:sqlite`，无任何原生/外部依赖）
- `npm install` 后 `npm test` 即可运行全部测试

## 用法

```ts
import { CanaryCoordinator } from 'sqlite-canary-migration';

const coordinator = new CanaryCoordinator({ stateDbPath: '/path/to/state.db' });

// 1. 提交批次（幂等：同一 batchId 重复提交返回原批次）
coordinator.submit({
  batchId: 'add-user-index',
  dbPaths: ['/data/canary.db', '/data/proj-a.db', '/data/proj-b.db'], // 1..20 个，有序不重复
  startVersion: 3,        // 目标版本 = 4
  sql: 'ALTER TABLE ...; UPDATE ...;', // 多条语句，不含事务控制/PRAGMA/ATTACH
});

// 2. 推进批次直到终态（succeeded / failed）；进程被杀后重新调用即可收敛
const progress = coordinator.advance('add-user-index');

// 3. 查询进度：publishing / rolling_back / succeeded / failed
const current = coordinator.query('add-user-index');
```

## 行为保证

- **金丝雀先行**：第一个库完成全部 SQL、通过外键校验并真实提交后，才处理其余库。
- **单库原子**：每个库的迁移 SQL 与版本推进（`__canary_meta` 表）在同一事务内。
- **整批撤回**：任一库 SQL 错误或外键违规，所有已发布库通过提交前的整文件备份
  恢复业务数据、结构、自增进度（`sqlite_sequence`）与迁移版本。
- **崩溃恢复**：批次状态与逐库进度持久化在状态库中，备份/恢复均先写临时文件再
  原子改名；进程在任意时刻被杀后，重新 `advance` 必收敛。已提交的库按版本识别，
  绝不重放非幂等 SQL；终态不可逆，重试旧标识不会再修改任何文件。

## 开发

```sh
npm run build   # tsc -> dist/
npm test        # 构建并运行 node:test 测试（含故障注入的崩溃恢复场景）
```
