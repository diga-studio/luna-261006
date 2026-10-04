/**
 * 最小费用流：连续最短路（SPFA）增广。
 * 图规模很小（节点数 = 科目数 + 部门数 + 2，流量 <= 科目数 * 部门数），
 * 因此不做势函数优化，直接每轮 SPFA 找最短路，允许负费用边。
 */
export interface McfEdge {
    from: number;
    to: number;
    capacity: number;
    cost: number;
}
export interface MinCostFlowResult {
    /** 与输入边一一对应的流量。 */
    flows: number[];
    /** 总费用。 */
    totalCost: number;
}
export declare function minCostFlow(nodeCount: number, edges: readonly McfEdge[], source: number, sink: number, requiredFlow: number): MinCostFlowResult;
