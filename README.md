# hr-case-import

历史 HR 案件 CSV 增量导入库（TypeScript / Node.js / SQLite）。

## 特性

- **崩溃安全**：任意时刻 `kill -9`，数据库始终表示一个已完成的逻辑记录前缀；重开任务续跑，最终结果（案件内容、revision、逐行结果、计数）与不中断的顺序导入完全一致。
- **增量推进**：每次 `advanceImport` 处理 128 条逻辑记录并在一个事务中持久化；已完成任务再次调用是无副作用空操作。
- **断点续扫**：任务持久化已提交的源文件字节偏移，恢复时从偏移处精确 seek，绝不重扫已完成前缀。
- **流式解析**：64 KiB 分块读取 + 字节级 CSV 状态机，单条记录上限 64 KiB，内存占用与文件大小无关（实测 29 MB 文件导入峰值 RSS ≈ 95 MB）。

## 用法

```ts
import { HrImporter } from "hr-case-import";

const importer = new HrImporter("/path/to/db.sqlite"); // 数据库路径由调用方传入
const id = importer.createImport("/path/to/cases.csv");

for (;;) {
  const r = importer.advanceImport(id); // 每次推进 128 条
  if (r.done) break;
}

const info = importer.inspectImport(id, 0, 100); // 计数 + 逐行结果分页
const c = importer.getCase("EMP-1");             // 案件字段 + revision
importer.close();
```

## CSV 约定

- 固定表头 `external_id,category,description`，记录号从 1 开始且不计表头。
- UTF-8（可有 BOM）；支持带引号字段、字段内逗号/换行、`""` 转义、CRLF/LF、末记录无换行。
- 字段值除 CSV 解码外不做任何归一化。
- `external_id` 为空或 `category` 不在 `harassment / discrimination / safety violation / fraud / retaliation / other` 之内的记录为失败行：产生失败结果、推进记录号、不改变案件、不阻断后续记录。
- 成功行按 `external_id` 创建或覆盖案件；新案件 revision 为 1，已有案件每成功处理一行 revision 加 1（即使内容相同）。

## 崩溃一致性设计

- 每次推进 = 一个 SQLite 事务（WAL + `synchronous=FULL`）：逐行结果、案件 upsert、任务计数与 `read_offset` 原子提交。
- 事务中途被杀 → SQLite 回滚 → `read_offset` 仍指向上一个已提交边界 → 续跑重新读取并处理未提交的记录，无漏行、无重复副作用。
- 提交后、返回前被杀 → 进度已持久化 → 续跑从下一条记录继续。
- 不使用案件号/内容哈希去重；幂等性完全来自"偏移 + 事务"的行级重放。

## 测试

```sh
npm install
npm test
```

测试覆盖：

- CSV 解析器：多字节字符跨块、引号/换行/逗号字段、`""` 转义、CRLF/LF/CR、BOM、无末尾换行、字节偏移精确性。
- 组合了多字节字符、跨行字段、转义引号、失败行、重复案件号、无末尾换行的文件：逐次重开库推进 vs 一次连续导入，逐项比较案件、revision、逐行结果与计数。
- 子进程在"事务未提交"与"已提交未返回"两个暂停点被 `SIGKILL` 后续跑，与参考导入做全量快照对比（暂停点为测试专用钩子，真实杀进程而非抛异常）。
- 大文件深处恢复：通过 `onRead` 钩子记录实际源文件读取范围，证明续跑的所有读取都不低于已提交偏移（不重扫已完成前缀），且 64 KiB 块读取天然跨记录预读。
