import type { PageReader, SiteEdge, SiteGraph, SiteNode } from './types.js';

interface NodeState {
  /** 规范化后的地址。 */
  url: string;
  /** 当前已知的最短深度，只会单调下降。 */
  depth: number;
  /** 是否已发起过读取（保证每个地址最多读一次）。 */
  scheduled: boolean;
  /** 读取是否已完成。 */
  read: boolean;
  /** 读取得到的出边，目标均为已规范化且同源的地址。 */
  edges: SiteEdge[];
}

/**
 * 限深站点爬取。
 *
 * - 种子深度为 0；普通链接 +1 层，重定向 +0 层。
 * - 只有当前已知深度不超过 maxDepth 的地址才会被接纳并读取，且最多读一次。
 * - 后来发现更短路径时，深度沿已读取的边重新传播，曾因超深未接纳的地址会重新进入范围。
 * - 读取完成顺序不影响最终结果：收敛后每个地址的深度等于已读取关系中的最短距离。
 */
export function crawlSite(
  seed: string,
  maxDepth: number,
  reader: PageReader,
): Promise<SiteGraph> {
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError('maxDepth must be a non-negative integer');
  }

  const nodes = new Map<string, NodeState>();
  const queue: string[] = [];
  const inQueue = new Set<string>();
  let pendingReads = 0;
  let settled = false;

  // 只接纳与种子同源的 http/https 地址；origin 在种子规范化后才能确定。
  let seedOrigin: string | null = null;

  const normalize = (raw: string, base?: string): string | null => {
    let url: URL;
    try {
      url = base === undefined ? new URL(raw) : new URL(raw, base);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    if (seedOrigin !== null && url.origin !== seedOrigin) return null;
    return url.href;
  };

  const seedKey = normalize(seed);
  if (seedKey === null) {
    throw new TypeError(`seed must be an absolute http(s) URL: ${seed}`);
  }
  seedOrigin = new URL(seedKey).origin;

  const enqueue = (key: string): void => {
    if (!inQueue.has(key)) {
      inQueue.add(key);
      queue.push(key);
    }
  };

  /** 记录一条新路径；只有深度变小时才需要重新处理。 */
  const discover = (key: string, depth: number): void => {
    const existing = nodes.get(key);
    if (existing === undefined) {
      nodes.set(key, { url: key, depth, scheduled: false, read: false, edges: [] });
    } else if (depth < existing.depth) {
      existing.depth = depth;
    } else {
      return;
    }
    enqueue(key);
  };

  const process = (key: string): void => {
    const node = nodes.get(key);
    if (node === undefined) return;
    // 当前已知深度在范围内且从未读过：接纳并读取（最多一次）。
    if (!node.scheduled && node.depth <= maxDepth) {
      node.scheduled = true;
      pendingReads += 1;
      void reader(node.url).then((result) => {
        pendingReads -= 1;
        if (result.kind === 'redirect') {
          const target = normalize(result.target, node.url);
          if (target !== null) {
            node.edges.push({ from: node.url, to: target, kind: 'redirect' });
          }
        } else {
          for (const raw of result.links) {
            const target = normalize(raw, node.url);
            if (target === null) continue;
            node.edges.push({ from: node.url, to: target, kind: 'link' });
          }
        }
        node.read = true;
        // 新边加入后统一通过 process 传播，兼容读取期间深度已下降的情况。
        enqueue(key);
        drain();
      });
    }
    // 把当前深度沿已知出边传播给邻居。
    for (const edge of node.edges) {
      discover(edge.to, node.depth + (edge.kind === 'link' ? 1 : 0));
    }
  };

  let finish: () => void;
  const done = new Promise<SiteGraph>((resolve) => {
    finish = () => {
      if (settled) return;
      settled = true;
      resolve(buildGraph());
    };
  });

  const buildGraph = (): SiteGraph => {
    const accepted = [...nodes.values()].filter((node) => node.read);
    const acceptedKeys = new Set(accepted.map((node) => node.url));
    const graphNodes: SiteNode[] = accepted
      .map((node) => ({ url: node.url, depth: node.depth }))
      .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    const seenEdges = new Set<string>();
    const graphEdges: SiteEdge[] = [];
    for (const node of accepted) {
      for (const edge of node.edges) {
        if (!acceptedKeys.has(edge.to)) continue;
        const id = `${edge.from} ${edge.to} ${edge.kind}`;
        if (seenEdges.has(id)) continue;
        seenEdges.add(id);
        graphEdges.push(edge);
      }
    }
    graphEdges.sort((a, b) => {
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      if (a.to !== b.to) return a.to < b.to ? -1 : 1;
      return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
    });
    return { seed: seedKey, maxDepth, nodes: graphNodes, edges: graphEdges };
  };

  const drain = (): void => {
    while (queue.length > 0) {
      const key = queue.shift();
      if (key === undefined) break;
      inQueue.delete(key);
      process(key);
    }
    if (pendingReads === 0) finish();
  };

  discover(seedKey, 0);
  drain();
  return done;
}
