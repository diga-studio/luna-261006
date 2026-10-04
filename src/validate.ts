import type { CanvasGraph } from "./types.js";

/**
 * Checks the graph invariants (unique positive integer ids, integer
 * coordinates, existing endpoints, no duplicate ordered pairs).
 * Throws on invalid input. Returns the graph unchanged.
 */
export function validateGraph(graph: CanvasGraph): CanvasGraph {
  if (graph === null || typeof graph !== "object") {
    throw new TypeError("graph must be an object with nodes and edges");
  }
  const { nodes, edges } = graph;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new TypeError("graph.nodes and graph.edges must be arrays");
  }

  const ids = new Set<number>();
  for (const node of nodes) {
    if (node === null || typeof node !== "object") {
      throw new TypeError("each node must be an object");
    }
    if (!Number.isInteger(node.id) || node.id <= 0) {
      throw new TypeError(`node id must be a positive integer, got ${String(node.id)}`);
    }
    if (ids.has(node.id)) {
      throw new TypeError(`duplicate node id ${node.id}`);
    }
    ids.add(node.id);
    if (typeof node.title !== "string") {
      throw new TypeError(`node ${node.id}: title must be a string`);
    }
    if (!Number.isInteger(node.x) || !Number.isInteger(node.y)) {
      throw new TypeError(`node ${node.id}: coordinates must be integers`);
    }
  }

  const pairs = new Set<string>();
  for (const edge of edges) {
    if (edge === null || typeof edge !== "object") {
      throw new TypeError("each edge must be an object");
    }
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new TypeError(
        `edge (${String(edge.from)} -> ${String(edge.to)}) references an unknown node`,
      );
    }
    const key = `${edge.from}→${edge.to}`;
    if (pairs.has(key)) {
      throw new TypeError(`duplicate edge ${edge.from} -> ${edge.to}`);
    }
    pairs.add(key);
  }

  return graph;
}
