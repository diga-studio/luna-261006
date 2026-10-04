import { maxBranching, type WeightedEdge } from "./branching.js";
import type {
  CanvasGraph,
  OutlineEntry,
  OutlineReference,
  OutlineResult,
} from "./types.js";
import { validateGraph } from "./validate.js";

function spatialCost(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

/** Replaces line breaks so a title stays on a single Markdown list line. */
function inlineTitle(title: string): string {
  return title.replace(/\s*\r?\n\s*/g, " ");
}

/** Computes the optimal hierarchy and renders it as a Markdown outline. */
export function exportOutline(graph: CanvasGraph): OutlineResult {
  validateGraph(graph);

  // Canonical order: everything downstream is derived from id-sorted input,
  // so the result does not depend on the caller's array ordering.
  const nodes = [...graph.nodes].sort((a, b) => a.id - b.id);
  const edges = [...graph.edges].sort((a, b) => a.from - b.from || a.to - b.to);

  if (nodes.length === 0) {
    return { roots: [], parents: new Map(), totalCost: 0, markdown: "" };
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const n = nodes.length;

  // Pack the three objectives into one BigInt weight per edge:
  //   minimize  R*B1 + C*B2 + S
  // R = number of top-level entries, C = total spatial cost of parent links,
  // S = parent-id sequence encoded as a base-B number (B > any node id).
  const base = BigInt(nodes[n - 1]!.id + 1);
  const digit = new Array<bigint>(n);
  digit[n - 1] = 1n;
  for (let i = n - 2; i >= 0; i--) digit[i] = digit[i + 1]! * base;
  const b2 = digit[0]! * base; // > any possible S
  let maxCostSum = 0;
  for (const e of edges) {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    maxCostSum += spatialCost(a.x, a.y, b.x, b.y);
  }
  const b1 = b2 * BigInt(maxCostSum + 1); // > any possible C*B2 + S

  const rankOf = new Map<number, number>();
  nodes.forEach((node, i) => rankOf.set(node.id, i));

  const weighted: WeightedEdge[] = [];
  for (const e of edges) {
    if (e.from === e.to) continue; // a self-loop can never be a parent link
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const cost = spatialCost(a.x, a.y, b.x, b.y);
    const weight = b1 - BigInt(cost) * b2 - BigInt(e.from) * digit[rankOf.get(e.to)!]!;
    weighted.push({ from: e.from, to: e.to, weight });
  }

  const chosen = maxBranching(
    nodes.map((node) => node.id),
    weighted,
  );

  const parents = new Map<number, number>();
  for (const node of nodes) parents.set(node.id, chosen.get(node.id) ?? 0);

  let totalCost = 0;
  const childIds = new Map<number, number[]>();
  for (const node of nodes) childIds.set(node.id, []);
  for (const node of nodes) {
    const p = parents.get(node.id)!;
    if (p === 0) continue;
    childIds.get(p)!.push(node.id);
    const a = byId.get(p)!;
    totalCost += spatialCost(a.x, a.y, node.x, node.y);
  }

  // Every original edge is either a parent link or a reference under its source.
  const refIds = new Map<number, number[]>();
  for (const node of nodes) refIds.set(node.id, []);
  for (const e of edges) {
    if (parents.get(e.to) !== e.from) refIds.get(e.from)!.push(e.to);
  }

  const entries = new Map<number, OutlineEntry>();
  for (const node of nodes) {
    entries.set(node.id, {
      nodeId: node.id,
      title: node.title,
      parentId: parents.get(node.id)!,
      children: [],
      references: [],
    });
  }
  const roots: OutlineEntry[] = [];
  for (const node of nodes) {
    const entry = entries.get(node.id)!;
    for (const cid of childIds.get(node.id)!) {
      entry.children.push(entries.get(cid)!);
    }
    for (const tid of refIds.get(node.id)!) {
      const ref: OutlineReference = { targetId: tid, targetTitle: byId.get(tid)!.title };
      entry.references.push(ref);
    }
    if (entry.parentId === 0) roots.push(entry);
  }

  const lines: string[] = [];
  const render = (entry: OutlineEntry, depth: number): void => {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- ${inlineTitle(entry.title)} (#${entry.nodeId})`);
    for (const child of entry.children) render(child, depth + 1);
    for (const ref of entry.references) {
      lines.push(
        `${indent}  - → ${inlineTitle(ref.targetTitle)} (#${ref.targetId})`,
      );
    }
  };
  for (const root of roots) render(root, 0);

  return {
    roots,
    parents,
    totalCost,
    markdown: lines.length === 0 ? "" : lines.join("\n") + "\n",
  };
}
