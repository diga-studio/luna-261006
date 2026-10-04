# depth-limited-crawler

由上层调用的限深站点爬取库（TypeScript）。状态只保存在单次运行的内存中，
返回本次运行收集到的完整站点图。链接提取与实际网络访问不属于本模块，
由调用方以进程内异步页面读取器的形式注入。

## 使用

```ts
import { crawlSite } from 'depth-limited-crawler';

const graph = await crawlSite(seedUrl, maxDepth, async (url) => {
  // 返回 { kind: 'links', links: [...] } 或 { kind: 'redirect', target: '...' }
});
```

- `graph.nodes`：已接纳（已读取）的规范化地址。
- `graph.edges`：已读取页面之间的普通链接与重定向关系。
- `graph.depths`：每个地址的最终深度，等于已读取关系中从种子出发的
  最短距离（普通链接花费 1，重定向花费 0）。

## 规则摘要

- 地址按 WHATWG URL 语义解析，相对地址以产生它的页面地址为基准；
  去掉片段后判重，查询参数顺序保留，不额外解码路径。
- 只接纳与种子同源的 HTTP/HTTPS 地址（协议 + 主机 + 端口，均按规范化后判断）。
- 种子深度为 0；只有当前已知深度不超过 D 的地址才会被读取；
  深度恰为 D 的页面仍会被读取，其重定向可继续。
- 每个规范化地址在一次运行中最多读取一次；后发现更短路径时，
  已读取页面及其后代的深度会被修正，先前因超深未接纳的地址会补读。
- 重定向环与普通链接环都能正常结束；结果不受读取完成顺序影响。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js 与 `typescript`（devDependency），无需其他服务。
