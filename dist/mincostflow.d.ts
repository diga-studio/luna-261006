/**
 * Min-cost flow over a directed graph with non-negative integer costs,
 * solved by successive shortest augmenting paths with Johnson potentials.
 *
 * Costs may exceed 2^32 but must stay well below 2^53 (exact in float64).
 */
export interface FlowEdge {
    to: number;
    rev: number;
    cap: number;
    cost: number;
}
export declare class MinCostFlow {
    private readonly graph;
    addNode(): number;
    nodeCount(): number;
    /** Adds a directed edge plus its residual reverse edge. */
    addEdge(from: number, to: number, capacity: number, cost: number): FlowEdge;
    /**
     * Pushes flow from source to sink until `limit` units are sent or no
     * augmenting path remains. Returns [flow, cost].
     */
    solve(source: number, sink: number, limit: number): [number, number];
    /** Nodes reachable from `source` via residual (cap > 0) edges. */
    reachableFrom(source: number): boolean[];
}
