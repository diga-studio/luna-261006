import type { CanvasGraph } from "./types";

function isInteger(value: number): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

/** Throws when the input graph violates the documented constraints. */
export function validateGraph(graph: CanvasGraph): void {
  if (graph === null || typeof graph !== "object") {
    throw new TypeError("graph must be an object");
  }
  const { nodes, edges } = graph;
  if (!Array.isArray(nodes)) {
    throw new TypeError("graph.nodes must be an array");
  }
  if (!Array.isArray(edges)) {
    throw new TypeError("graph.edges must be an array");
  }

  const ids = new Set<number>();
  for (const node of nodes) {
    if (node === null || typeof node !== "object") {
      throw new TypeError("each node must be an object");
    }
    if (!isInteger(node.id) || node.id <= 0) {
      throw new TypeError(`node id must be a positive integer, got ${String(node.id)}`);
    }
    if (ids.has(node.id)) {
      throw new TypeError(`duplicate node id ${node.id}`);
    }
    ids.add(node.id);
    if (typeof node.title !== "string") {
      throw new TypeError(`node ${node.id}: title must be a string`);
    }
    if (!isInteger(node.x) || !isInteger(node.y)) {
      throw new TypeError(`node ${node.id}: coordinates must be integers`);
    }
  }

  const seenEdges = new Set<string>();
  for (const edge of edges) {
    if (edge === null || typeof edge !== "object") {
      throw new TypeError("each edge must be an object");
    }
    if (!ids.has(edge.from)) {
      throw new TypeError(`edge references unknown node ${String(edge.from)}`);
    }
    if (!ids.has(edge.to)) {
      throw new TypeError(`edge references unknown node ${String(edge.to)}`);
    }
    const key = `${edge.from}→${edge.to}`;
    if (seenEdges.has(key)) {
      throw new TypeError(`duplicate edge ${edge.from} -> ${edge.to}`);
    }
    seenEdges.add(key);
  }
}
