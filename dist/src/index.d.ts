import { AttackPath, Topology } from "./types";
export * from "./types";
/**
 * 查询从入口资产到目标资产的前十条最高风险攻击路径。
 * 排序：分数降序；同分按连接数升序；再相同按连接编号序列数字字典序升序。
 */
export declare function findTopAttackPaths(topology: Topology, entryId: number, targetId: number): AttackPath[];
