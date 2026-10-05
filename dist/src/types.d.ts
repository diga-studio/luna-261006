/** 协议类型（固定三种） */
export declare enum Protocol {
    ModbusTcp = "Modbus TCP",
    DNP3 = "DNP3",
    OpcUa = "OPC-UA"
}
/** 资产：唯一编号、Purdue 层级（0-5）、关键程度（1-10） */
export interface Asset {
    id: number;
    purdueLevel: number;
    criticality: number;
}
/** 连接：唯一编号、两个端点、协议、单向/双向 */
export interface Connection {
    id: number;
    from: number;
    to: number;
    protocol: Protocol;
    bidirectional: boolean;
}
/** 完整拓扑 */
export interface Topology {
    assets: Asset[];
    connections: Connection[];
}
/** 一条攻击路径结果 */
export interface AttackPath {
    /** 完整连接编号序列（按行进顺序） */
    connectionIds: number[];
    /** 路径分数 */
    score: number;
}
