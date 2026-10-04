/** 读取器对单个地址的返回：普通页面给出链接列表，重定向给出唯一目标。 */
export type PageResult =
  | { kind: 'links'; links: readonly string[] }
  | { kind: 'redirect'; target: string };

/** 调用方提供的进程内异步页面读取器。不会失败，最终会结束。 */
export type PageReader = (url: string) => Promise<PageResult>;

export type EdgeKind = 'link' | 'redirect';

export interface SiteNode {
  /** 规范化后的地址（去片段、保留查询顺序、不额外解码路径）。 */
  url: string;
  /** 从种子出发、按已读取关系计算的最短距离（重定向计 0，普通链接计 1）。 */
  depth: number;
}

export interface SiteEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/** 单次运行得到的完整站点图。节点与边均按字典序排序，与读取完成顺序无关。 */
export interface SiteGraph {
  /** 规范化后的种子地址。 */
  seed: string;
  maxDepth: number;
  nodes: SiteNode[];
  edges: SiteEdge[];
}
