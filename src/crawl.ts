import { normalizeAddress } from './normalize.js';
import type { PageReader, SiteEdge, SiteGraph } from './types.js';

export type { PageReader, PageResult, SiteEdge, SiteGraph } from './types.js';

/** 在已读取关系上做 0-1 BFS：重定向花费 0，普通链接花费 1。 */
function shortestDistances(seed: string, edges: readonly SiteEdge[]): Map<string, number> {
  const adjacency = new Map<string, { to: string; cost: number }[]>();
  for (const edge of edges) {
    const cost = edge.kind === 'redirect' ? 0 : 1;
    const list = adjacency.get(edge.from);
    const item = { to: edge.to, cost };
    if (list) list.push(item);
    else adjacency.set(edge.from, [item]);
  }
  const dist = new Map<string, number>([[seed, 0]]);
  // 0-1 BFS 双端队列（用数组模拟，头部用下标推进）。
  const deque: string[] = [seed];
  let head = 0;
  while (head < deque.length) {
    const from = deque[head++]!;
    const fromDist = dist.get(from)!;
    for (const { to, cost } of adjacency.get(from) ?? []) {
      const next = fromDist + cost;
      const known = dist.get(to);
      if (known === undefined || next < known) {
        dist.set(to, next);
        if (cost === 0) deque.splice(head, 0, to);
        else deque.push(to);
      }
    }
  }
  return dist;
}

/**
 * 从种子地址出发做限深爬取。
 *
 * @param seed 种子 URL（深度为 0）。
 * @param maxDepth 深度上限 D。
 * @param reader 进程内异步页面读取器。
 * @returns 本次运行收集到的完整站点图。
 */
export async function crawlSite(
  seed: string,
  maxDepth: number,
  reader: PageReader,
): Promise<SiteGraph> {
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error('maxDepth must be a non-negative integer');
  }
  let seedOrigin: string;
  try {
    const seedUrl = new URL(seed);
    if (seedUrl.protocol !== 'http:' && seedUrl.protocol !== 'https:') {
      throw new Error('seed must be an HTTP or HTTPS URL');
    }
    seedOrigin = seedUrl.protocol + '//' + seedUrl.host;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('seed must')) throw error;
    throw new Error('seed must be a valid absolute URL');
  }
  const seedCanonical = normalizeAddress(seed, seed, seedOrigin)!.canonical;

  const discovered = new Set<string>([seedCanonical]);
  const readSet = new Set<string>();
  const edges: SiteEdge[] = [];
  const edgeKeys = new Set<string>();

  const recordEdge = (from: string, to: string, kind: SiteEdge['kind']): void => {
    const key = JSON.stringify([from, kind, to]);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind });
    discovered.add(to);
  };

  const inFlight = new Map<string, Promise<void>>();

  for (;;) {
    const dist = shortestDistances(seedCanonical, edges);
    for (const address of discovered) {
      const depth = dist.get(address);
      if (
        depth !== undefined &&
        depth <= maxDepth &&
        !readSet.has(address) &&
        !inFlight.has(address)
      ) {
        const task = reader(address)
          .then((result) => {
            if (result.kind === 'redirect') {
              const normalized = normalizeAddress(result.target, address, seedOrigin);
              if (normalized) recordEdge(address, normalized.canonical, 'redirect');
            } else {
              for (const link of result.links) {
                const normalized = normalizeAddress(link, address, seedOrigin);
                if (normalized) recordEdge(address, normalized.canonical, 'link');
              }
            }
            readSet.add(address);
          })
          .finally(() => {
            inFlight.delete(address);
          });
        inFlight.set(address, task);
      }
    }
    if (inFlight.size === 0) break;
    await Promise.all([...inFlight.values()]);
  }

  const finalDepths = shortestDistances(seedCanonical, edges);
  const nodes = [...readSet].sort();
  const nodeSet = new Set(nodes);
  const finalEdges = edges
    .filter((edge) => nodeSet.has(edge.from) && nodeSet.has(edge.to))
    .sort((a, b) =>
      (a.from + a.kind + a.to).localeCompare(b.from + b.kind + b.to),
    );
  const depths = new Map<string, number>();
  for (const node of nodes) {
    depths.set(node, finalDepths.get(node)!);
  }
  return { seed: seedCanonical, nodes, edges: finalEdges, depths };
}
