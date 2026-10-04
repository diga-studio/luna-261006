# task26100642

限深站点爬取库（TypeScript）。状态只保存在单次运行的内存中，运行结束返回完整的本次站点图。

## 用法

```ts
import { crawlSite, type PageReader } from 'depth-limited-crawler';

const reader: PageReader = async (url) => {
  // 由调用方实现：返回 { kind: 'links', links: [...] } 或 { kind: 'redirect', target: '...' }
};

const graph = await crawlSite('https://example.com/', 2, reader);
// graph.nodes: [{ url, depth }]  —— 已接纳地址及其最终深度（最短距离）
// graph.edges: [{ from, to, kind }] —— 已接纳地址之间的普通链接与重定向关系
```

## 语义

- 种子深度为 0；普通链接 +1 层，重定向 +0 层（不消耗深度）。
- 地址按 WHATWG URL 语义解析，相对地址以产生它的页面地址为基准；去掉片段后判重，
  保留查询参数顺序，不额外解码路径；只接纳与种子同源的 http/https 地址。
- 只有当前已知深度不超过上限的地址才会被接纳并读取；每个规范化地址最多读取一次。
- 后发现更短路径时，已读取页面及其后代的深度会沿已读取关系重新收敛；
  曾因超深未接纳的地址进入范围后会被补读。
- 所有已接纳地址读取完成、深度与覆盖范围不再变化时才返回；
  最终结果与读取完成顺序无关。

## 构建与测试

```sh
npm install
npm test
```

只需要 Node.js；`npm test` 先用 `tsc` 编译到 `dist/`，再用 Node 内置测试运行器执行。
