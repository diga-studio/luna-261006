/** 协议类型，仅支持 TCP 与 UDP。 */
export type Protocol = "TCP" | "UDP";

/** 规则动作。 */
export type Action = "allow" | "deny";

/** 一条微隔离策略规则。CIDR 为规范化 IPv4 CIDR（如 "10.0.0.0/8"，单资产为 /32，/0 覆盖全空间）。 */
export interface Rule {
  /** 唯一标识。 */
  id: string;
  sourceCidr: string;
  destinationCidr: string;
  protocol: Protocol;
  /** 目的端口闭区间下界，1-65535。 */
  portStart: number;
  /** 目的端口闭区间上界，1-65535。 */
  portEnd: number;
  action: Action;
  /** 优先级，数值越小越先匹配。 */
  priority: number;
}

/** 一个数据包。地址为点分十进制 IPv4。 */
export interface Packet {
  sourceAddress: string;
  destinationAddress: string;
  protocol: Protocol;
  destinationPort: number;
}

/** 发布结果：成功，或失败并携带一个冲突数据包见证。 */
export type PublishResult =
  | { ok: true }
  | { ok: false; witness: Packet };

/** 对单个数据包的判定结果。 */
export type Decision =
  | { kind: "action"; action: Action; priority: number; matchedRuleIds: string[] }
  | { kind: "conflict"; priority: number; matchedRuleIds: string[] }
  | { kind: "default-deny" };
