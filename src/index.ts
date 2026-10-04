import { validateGraph } from "./validate";
import { computeParents } from "./optimize";
import { buildOutline } from "./outline";
import { renderMarkdown } from "./markdown";
import type { CanvasGraph, OutlineResult } from "./types";

export * from "./types";

/**
 * Exports a canvas graph to a hierarchical Markdown outline.
 *
 * The graph is treated as immutable for the duration of the call.
 * The result is deterministic: permuting the input node/edge arrays
 * yields the same hierarchy and byte-identical Markdown.
 */
export function exportOutline(graph: CanvasGraph): OutlineResult {
  validateGraph(graph);
  const parents = computeParents(graph);
  const { entries, totalCost } = buildOutline(graph, parents);
  const markdown = renderMarkdown(entries);
  return {
    entries,
    parents: [...parents.entries()]
      .map(([nodeId, parentId]) => ({ nodeId, parentId }))
      .sort((a, b) => a.nodeId - b.nodeId),
    totalCost,
    markdown,
  };
}
