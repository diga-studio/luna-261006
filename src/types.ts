/** 资产（设备） */
export interface Asset {
  /** 唯一编号 */
  id: number;
  /** Purdue 层级，0-5 */
  level: number;
  /** 关键程度，1-10 */
  criticality: number;
}

/** 协议类型 */
export type Protocol = "Modbus TCP" | "DNP3" | "OPC-UA";

/** 连接（边） */
export interface Connection {
  /** 唯一编号 */
  id: number;
  /** 端点 A 的资产编号 */
  from: number;
  /** 端点 B 的资产编号 */
  to: number;
  protocol: Protocol;
  /** true 表示双向通行，false 表示仅 from -> to */
  bidirectional: boolean;
}

/** 完整拓扑 */
export interface Topology {
  assets: Asset[];
  connections: Connection[];
}

/** 一条攻击路径 */
export interface AttackPath {
  /** 完整连接编号序列 */
  connectionIds: number[];
  /** 途经资产编号序列（含入口与目标） */
  assetIds: number[];
  /** 路径分数 */
  score: number;
}

/** 路径分析器 */
export interface PathAnalyzer {
  /**
   * 查询从入口资产到目标资产的前十条最高风险路径。
   * 不足十条时全部返回，不可达时返回空数组。
   */
  findTopPaths(entryId: number, targetId: number): AttackPath[];
}
