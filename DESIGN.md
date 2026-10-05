# 设计说明

一个 SQLite 文件同时保存文档与全部索引，零外部服务，仅依赖 Node.js 内置的
`node:sqlite`（含 FTS5）。

## 存储布局

- `meta(key, value)`：`latest_generation`（已分配的最大世代）、
  `published_generation`、`published_fields`（已发布索引的字段集合，JSON）。
- `docs(id, data)`：文档当前内容（JSON），`id` 为主键。
- `changes(seq, id)`：变更日志。每次 `put` 在同一个事务里追加一行，
  `seq` 自增，作为重建期间增量回放的依据。
- `fts_<gen>(id UNINDEXED, c0..cN)`：每个索引世代一张 FTS5 虚表，
  列 `c0..cN` 按顺序对应该世代的字段集合（列名与字段名解耦，避免标识符转义问题）。

初始状态：`latest_generation = published_generation = 0`，字段集合为空，
此时 `search` 直接返回空结果。

## put 的事务边界

`put` 在**一个事务**内完成：写 `docs`（或删除）、追加 `changes`、
把同一变更应用到当前已发布的 FTS 表（按 `id` 删除旧行后按新内容插入；
删除文档则只删不插）。事务提交后 `put` 才返回，因此已发布的旧索引
始终实时反映全部已提交的修改——重建期间读写都走已发布索引，不受影响。

## rebuild 与发布的原子边界

1. **进入时**（同步）：`latest_generation + 1` 分配本调用的 generation 并持久化；
   同时记录 `changes` 当前的最大 `seq` 记为 `s0`。
2. **扫描**：按 `id` 分批（256 行/批）把 `docs` 快照式地写入新的
   `fts_<gen>`，每批一个事务，批与批之间让出事件循环，
   因此扫描期间 `put`/`search` 照常完成。
3. **发布**：先在事务外检查 `generation < latest_generation`——若已有更新的
   rebuild 进入，本调用只能丢弃新表并返回 `superseded`。否则在**一个事务**内完成：
   - 回放 `changes` 中 `seq > s0` 的全部条目：对每个变更过的 `id`，
     从新 FTS 表删除后按 `docs` 的**当前**内容重新插入（文档已删除则只删）；
   - 更新 `published_generation` 与 `published_fields`。
   这个事务就是发布的原子边界：它提交的瞬间，新索引恰好等于
   「扫描结果 + 扫描期间全部已提交修改」，与 `docs` 在该时刻的状态一致。
   由于所有数据库操作都是同步的，该事务不会被其他操作穿插。

## 为什么扫描期间的修改不会被旧内容覆盖

- 扫描只**追加**新行，从不修改已发布索引；已发布索引由 `put` 自己维护。
- 扫描可能把旧值写进新表（例如某文档在扫描后被替换），但发布前的回放
  以 `changes` 日志为准，按 `docs` 的当前内容重建这些文档的索引行，
  且「先按 id 删、再按当前内容插」是幂等的：无论该文档被扫描过、
  被回放覆盖过、还是两者都发生过，最终结果都只取决于发布事务提交时
  `docs` 中的内容。被删除的文档在回放时只删不插，不会复活。

## 重叠 rebuild 的次序保证

- generation 在进入时同步分配，严格递增。
- 发布前的检查保证：只要有更新的 rebuild 已经分配了 generation，
  较旧的调用一律 `superseded`，不可能再发布；因此最新调用完成后，
  较旧调用即使最后结束也无法覆盖它，查询不会发生版本倒退。
- 已发布的旧索引在新索引发布前一直服务；发布后才删除旧 FTS 表。

## search 的一致性

`search` 先读 `published_generation`/`published_fields`，再对对应的
`fts_<gen>` 执行 FTS5 查询（`MATCH '"<term>"'`，unicode61 分词器默认
大小写不敏感、完整词匹配）。整个过程是同步的，不会被 `put` 或发布事务
穿插，因此返回的 `(generation, ids)` 必然对应调用到返回之间某一瞬间的
完整数据库状态。

## 测试

`test/index.test.ts` 通过 `onScanBatch` 钩子（仅测试用）在批次间暂停重建，
确定性地构造交错时序：

- 重建期间提交插入、整篇替换（覆盖已扫描与未扫描文档）与删除，
  逐次核对每次 `search` 返回的 generation 对应的完整命中集合，
  发布后核对完整结果（无旧值复活、无漏项、无已删除文档）；
- 字段不同的新重建先完成、旧重建后结束，验证旧调用返回 `superseded`
  且后续查询不发生版本倒退。
