# vaultterm-audit-ledger

可按主体擦除的防篡改审计账本（TypeScript 库），数据持久化到 SQLite（Node 内置 `node:sqlite`，无原生依赖）。

## 能力

- `AuditLedger.open(path)`：打开或创建账本。
- `append(subject, body)`：按调用顺序追加记录，账本分配不可复用的递增序号；返回序号与新凭据。
- `eraseSubject(subject)`：擦除该主体当前全部存活记录（墓碑化：明文与检索关联移除，仅保留承诺哈希与擦除事实）；无匹配记录时账本与凭据不变。
- `verify(credential)`：依据 SQLite 数据与调用方保管的凭据核验账本。最新凭据与此前发出的旧凭据均可核验。
- `getLiveRecord` / `listLiveRecords` / `currentCredential` / `close`。

## 设计

- `records` 表：存活行保存明文与内容承诺哈希 `H(seq, subject, canonical(body))`；擦除后变为墓碑（明文置空），仅保留承诺哈希作为完整性材料。
- `ops` 表：仅追加的操作日志（append / erase），每条携带链式状态哈希。凭据 = `(opCount, recordCount, stateHash)`，即日志前缀的承诺，不含业务原文。
- 擦除不改动其他记录的序号、顺序与正文，也不改动日志前缀，因此旧凭据持续有效。
- 核验不信任库内缓存，重放全部操作日志并与 `records` 逐行对账：墓碑必须有对应擦除事实，存活记录明文必须重算出已承诺的哈希。正文/主体篡改、调换、未授权删除、伪造擦除、末尾截断、整库回滚均被最新凭据拒绝。

## 使用

```ts
import { AuditLedger } from "vaultterm-audit-ledger";

const ledger = AuditLedger.open("audit.db");
const { seq, credential } = ledger.append("user-123", { op: "login" });
// credential 由调用方另行保管（不包含业务原文）
const erased = ledger.eraseSubject("user-123");
const result = ledger.verify(erased.credential); // { ok: true }
ledger.close();
```

## 构建与测试

要求 Node.js >= 22.5（内置 `node:sqlite`）。

```sh
npm install
npm test
```
