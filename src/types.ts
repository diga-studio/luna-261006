/** 页面读取器返回的内容：普通链接列表，或单个重定向目标。 */
export type PageResult =
  | { kind: 'links'; links: string[] }
  | { kind: 'redirect'; target: string };

/** 调用方提供的进程内异步页面读取器。 */
export type PageReader = (url: string) => Promise<PageResult>;

/** 站点图中的一条有向边。 */
export interface SiteEdge {
  from: string;
  to: string;
  kind: 'link' | 'redirect';
}

/** 一次爬取运行产出的完整站点图。 */
export interface SiteGraph {
  /** 规范化后的种子地址。 */
  seed: string;
  /** 所有已接纳（已读取）的规范化地址。 */
  nodes: string[];
  /** 已读取页面之间的普通链接与重定向关系。 */
  edges: SiteEdge[];
  /** 每个已接纳地址的最终深度（从种子出发的最短距离）。 */
  depths: ReadonlyMap<string, number>;
}
