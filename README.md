# hr-case-import

历史 HR 案件 CSV 增量导入库（TypeScript / Node.js / SQLite）。崩溃安全：任意时刻杀死进程，数据库始终表示一个已完成的逻辑记录前缀；重开任务续跑，最终结果与不中断的顺序导入完全一致。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生依赖）

## 构建与测试

```sh
npm install
npm test
```

## API

```ts
import { createImporter } from "hr-case-import";

const imp = createImporter(dbPath);        // 数据库路径由调用方传入
const id = imp.createImport(csvPath);      // 持久化创建任务，返回任务 ID
const progress = imp.advanceImport(id);    // 处理接下来 128 条逻辑记录
const state = imp.inspectImport(id, 0, 50);// 计数 + 记录号 > after 的逐行结果
const kase = imp.getCase("CASE-001");      // 案件字段及 revision
imp.close();
```

- `advanceImport` 返回 `{ processed, completed, succeeded, failed, done }`；已完成任务再次调用返回 `processed: 0` 且不产生任何变化。
- `inspectImport(id, after, limit)` 返回已完成/成功/失败计数，以及记录号大于 `after` 的至多 `limit` 条逐行结果（含每条成功记录产生的 revision）。
- 失败行（`external_id` 为空或 `category` 非法）不改变案件，但产生失败结果并推进记录号。

## 崩溃安全设计

- 每条逻辑记录一个 SQLite 事务：案件 upsert（revision +1）、逐行结果、任务进度（下一条记录的字节偏移、记录号、计数）原子提交。任意时刻 kill，数据库都是已提交前缀。
- 任务表持久化下一条待处理记录的**字节偏移**。恢复时从该偏移重新打开文件继续解析，不重扫已完成前缀；解析器预读的未提交数据会被重新读取（允许），逻辑偏移保证不漏不重。
- 不使用内容哈希或案件号去重；行幂等完全由"偏移 + 原子事务"保证。

## 源文件假设

- 语法合法的 UTF-8 CSV，可有 BOM；首行为 `external_id,category,description` 三列表头。
- 支持带引号字段、字段内逗号与换行、`""` 转义、CRLF/LF、末记录无换行；每条逻辑记录编码后至多 64 KiB。
- 字段值除 CSV 解码外不做任何归一化。
- 单任务串行推进；源文件自任务创建起不可变。
