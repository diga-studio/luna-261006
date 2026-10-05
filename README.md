# fts5-doc-index

基于 TypeScript + SQLite FTS5 的文档集合在线全文索引库。文档与索引保存在
同一个 SQLite 文件中，重建索引期间读写不中断。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，其 SQLite 编译含 FTS5）
- 无运行时依赖；`typescript` 为唯一 devDependency

## 使用

```ts
import { DocumentIndex } from './src/index';

const idx = new DocumentIndex({ path: 'index.db' });
await idx.put('doc1', { title: 'Hello World', body: 'a brave new world' });
await idx.put('doc2', null);                 // 删除
const { generation, status } = await idx.rebuild(['title', 'body']);
const hits = await idx.search('hello');      // { generation, ids: ['doc1'] }
await idx.close();
```

- `put(id, doc)`：创建或整篇替换；`doc === null` 删除；返回时已提交。
- `rebuild(fields)`：进入时分配递增 generation，按给定字段集合构建并尝试
  发布，返回 `{ generation, status: 'published' | 'superseded' }`。
- `search(term)`：`term` 为单个小写 ASCII 单词，忽略大小写整词匹配，
  任一已索引字段命中即返回，附返回时服务的 generation。

## 构建与测试

```sh
npm install
npm test
```

设计说明见 [DESIGN.md](DESIGN.md)。
