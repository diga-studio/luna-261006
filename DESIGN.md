# 设计说明

一个 SQLite 文件同时保存文档与索引，逻辑表结构：

- `docs(id, data)`：当前已提交的文档，`data` 为 JSON。
- `meta(key, value)`：已发布的 `published_generation`、字段集合 `published_fields`、
  当前服务的 FTS 表名 `published_fts`。
- `changelog(seq, id)`：自最老的在途重建启动以来，每次 `put` 触碰的文档 id，
  `seq` 为自增序号（`BEGIN IMMEDIATE` 保证序号顺序即提交顺序）。
- `fts_N`：第 N 代重建的 FTS5 暂存表（`docid UNINDEXED` + 各索引字段）。
  发布后它就是服务表；被取代时直接丢弃。

## 各操作的边界

- **put**：单个 `BEGIN IMMEDIATE … COMMIT`。事务内依次更新 `docs`、
  把变更应用到当前已发布的 FTS 表（删除旧行、按已发布字段集合插入新行；
  删除文档则只删）、追加一条 `changelog`。返回时事务已提交。
  因此旧索引始终实时反映持续的写入。

- **search**：单个只读事务。在同一快照里读 `meta`（generation、FTS 表名）并
  查询该 FTS 表，返回的 generation 与结果必然对应同一瞬间的完整数据库状态。
  FTS5 的 `unicode61` 分词器天然提供忽略大小写的整词匹配。

- **rebuild(fields)**：
  1. 进入时同步分配递增 generation `g`，并记录 `baseSeq = max(changelog.seq)`。
  2. 在暂存表 `fts_g` 上按键序分批扫描 `docs`，批间让出事件循环，
     读写请求可以正常穿插执行。
  3. **发布边界**是最后一段完全同步的代码：若此时 `g` 已不是最大的已进入
     generation，说明有更新的重建进入，本次直接丢弃暂存表、返回
     `superseded`；否则在**一个** `BEGIN IMMEDIATE … COMMIT` 里完成：
     排空 `changelog` 中 `seq > baseSeq` 的变更 → 更新 `meta`
     （generation / 字段集合 / FTS 表名）→ 删除上一代 FTS 表 → 裁剪
     `changelog`。因为整段是同步的，put/search 不可能插入到检查与提交之间，
     这就是发布的原子边界：对任何观察者而言，meta 与新索引的切换不可分。

## 为什么扫描期间的修改不会被旧内容覆盖

扫描只是“打底”：重建只保证把 `baseSeq` 之前的状态拷进暂存表。所有在扫描
期间提交的 `put` 都会（a）更新 `docs`，（b）在 `changelog` 留下记录。发布
事务持有写锁，其间没有任何写能提交；事务内先按 `changelog` 中
`seq > baseSeq` 的 id 逐一从 `docs` 读取**当前**状态覆盖进暂存表（文档已删
除则从暂存表删除），再切换 meta。于是发布出的新索引恰好等于“发布那一刻
已提交的全部修改”作用于新字段集合的结果，扫描时拷入的旧值要么本来就有
效，要么已被排空步骤用新值替换。

## 重叠重建与 supersede

generation 在进入时同步分配。发布前检查 `g === maxEnteredGeneration`：
只要有更新的调用进入，旧调用就只能以 `superseded` 结束，绝不发布；最新
调用发布后，更旧的调用即使最后结束也无法覆盖它。已被取代的暂存表立即
删除，已发布的旧索引则继续服务，直到最新重建在其发布事务里原子切换。

`changelog` 的裁剪发生在发布事务内：只删除 `seq <=` 所有仍在途重建的
最小 `baseSeq` 的行——这些行必然已被每个在途重建的扫描覆盖；其余行留给
尚未完成的重建继续排空。
