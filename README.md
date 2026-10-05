# vaultterm-ledger

可按主体擦除的防篡改审计账本（TypeScript 库），数据持久化到 SQLite（Node 内置 `node:sqlite`，无原生依赖）。

## 构建与测试

```sh
npm install
npm test
```

要求 Node.js ≥ 22.5（`node:sqlite`）。唯一开发依赖是 TypeScript。

## API

```ts
import { Ledger } from "vaultterm-ledger";

const ledger = Ledger.open("audit.sqlite");

// 追加：账本分配不可复用的递增序号，返回可信凭据（由调用方另行保管）
const { seq, credential } = ledger.append("user-123", { op: "login" });

// 擦除：删除该主体当前全部存活记录的明文与检索关联，保留完整性材料与擦除事实
const eraseResult = ledger.erase("user-123"); // 无匹配时账本与凭据不变

// 核验：依据 SQLite 数据与调用方保管的凭据；旧凭据证明其历史前缀未被替换，
// 最新凭据同时证明哪些内容被合法擦除
const result = ledger.verify(credential); // { ok, reason }

ledger.close();
```

## 设计要点

- 每个条目（业务记录 / 擦除事件）提交到一条 SHA-256 哈希链：`entryHash = H(prevHash, leafHash)`。
- 业务记录的叶子哈希承诺序号、主体与 canonical JSON 正文；擦除只删除明文，保留叶子哈希，
  因此旧凭据覆盖的历史前缀在擦除后仍可重放核验。
- 擦除事件追加到链上，记录被擦除序号与主体的 keyed-hash（HMAC，密钥在库内），不含业务明文。
- 核验会重放整条链并检查：序号连续、存活记录内容与承诺一致、被擦除记录必须有对应擦除事件覆盖、
  擦除事件引用的记录必须确已擦除、凭据前缀的链头一致。
  篡改正文/主体、调换顺序、非法删除、伪造擦除、截断末尾、整库回滚均会被拒绝。
