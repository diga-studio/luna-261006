import type { CanvasGraph, OutlineEntry } from "./types";

/** Builds the hierarchy (full entries + reference entries) from a parent map. */
export function buildOutline(
  graph: CanvasGraph,
  parents: Map<number, number>
): { entries: OutlineEntry[]; totalCost: number } {
  const titleOf = new Map<number, string>();
  const coordOf = new Map<number, { x: number; y: number }>();
  for (const node of graph.nodes) {
    titleOf.set(node.id, node.title);
    coordOf.set(node.id, { x: node.x, y: node.y });
  }

  const entryOf = new Map<number, OutlineEntry>();
  const sortedIds = graph.nodes.map((node) => node.id).sort((a, b) => a - b);
  for (const id of sortedIds) {
    entryOf.set(id, { id, title: titleOf.get(id)!, children: [], references: [] });
  }

  const entries: OutlineEntry[] = [];
  let totalCost = 0;
  for (const id of sortedIds) {
    const parentId = parents.get(id) ?? 0;
    const entry = entryOf.get(id)!;
    if (parentId === 0) {
      entries.push(entry);
    } else {
      entryOf.get(parentId)!.children.push(entry);
      const a = coordOf.get(parentId)!;
      const b = coordOf.get(id)!;
      totalCost += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    }
  }

  // Every edge that was not chosen as a parent-child link becomes a
  // reference entry anchored at its source node.
  for (const edge of graph.edges) {
    if (parents.get(edge.to) === edge.from) {
      continue;
    }
    entryOf.get(edge.from)!.references.push({
      targetId: edge.to,
      targetTitle: titleOf.get(edge.to)!,
    });
  }
  for (const entry of entryOf.values()) {
    entry.references.sort((a, b) => a.targetId - b.targetId);
  }

  return { entries, totalCost };
}
