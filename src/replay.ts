import type { FlowDefinition, FlowNode, NodeId, ReplayResult } from './types';

/**
 * Deterministically executes the flow for one complete switch input.
 * Returns the visited node path and, on the first action whose required
 * fields are not all present, that node plus every missing field.
 * Independent of the publish-time analysis: a plain interpreter.
 */
export function replayFlow(flow: FlowDefinition, input: boolean[]): ReplayResult {
  const byId = new Map<NodeId, FlowNode>();
  let entry: FlowNode | undefined;
  for (const node of flow.nodes) {
    byId.set(node.id, node);
    if (node.kind === 'entry') entry = node;
  }
  if (entry === undefined) {
    throw new Error('flow has no entry node');
  }

  const present = new Set<string>();
  const path: NodeId[] = [];
  let current: FlowNode = entry;

  for (;;) {
    path.push(current.id);
    switch (current.kind) {
      case 'end':
        return { ok: true, path };
      case 'entry':
        current = byId.get(current.next)!;
        break;
      case 'condition':
        current = byId.get(input[current.switchIndex] ? current.onTrue : current.onFalse)!;
        break;
      case 'action': {
        const missing = current.requires.filter((f) => !present.has(f));
        if (missing.length > 0) {
          return { ok: false, path, failedNode: current.id, missingFields: missing };
        }
        for (const f of current.produces) present.add(f);
        current = byId.get(current.next)!;
        break;
      }
    }
  }
}
