# fts5-doc-index

用 TypeScript + SQLite FTS5 实现的文档集合在线全文索引库。
文档与索引保存在同一个 SQLite 文件中，重建索引期间读写不中断。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无需任何原生模块或外部服务）

## 构建与测试

```sh
npm install
npm test
```

## API

```ts
import { openIndex } from "fts5-doc-index";

const idx = openIndex("index.db");

await idx.put("doc1", { title: "hello world", body: "..." }); // 创建/整篇替换
await idx.put("doc1", null);                                  // 删除

const { generation, status } = await idx.rebuild(["title", "body"]);
// status: "published" | "superseded"

const hits = await idx.search("hello");
// { generation: 已发布的世代, ids: 命中文档 id 列表 }

await idx.close();
```

设计细节见 [DESIGN.md](DESIGN.md)。
