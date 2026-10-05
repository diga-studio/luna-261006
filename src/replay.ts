import type { FlowDefinition, FlowNode, NodeId, ReplayResult, SwitchAssignment } from './types.js';

/**
 * 按给定开关输入复现一次执行：返回经过的节点及首次失败的全部缺失字段；
 * 没有失败则返回成功。
 */
export function replayFlow(flow: FlowDefinition, switches: SwitchAssignment): ReplayResult {
  const nodeById = new Map<NodeId, FlowNode>(flow.nodes.map((n) => [n.id, n]));
  const switchIndex = new Map(flow.switches.map((name, i) => [name, i]));
  const present = new Set<string>();
  const path: NodeId[] = [];

  const entry = flow.nodes.find((n) => n.kind === 'entry');
  if (!entry) throw new Error('flow has no entry node');

  let current: FlowNode = entry;
  for (;;) {
    path.push(current.id);
    switch (current.kind) {
      case 'end':
        return { ok: true, path };
      case 'entry':
        current = nodeById.get(current.next)!;
        break;
      case 'condition': {
        const idx: number = switchIndex.get(current.switch)!;
        const value: boolean = switches[idx];
        current = nodeById.get(value ? current.onTrue : current.onFalse)!;
        break;
      }
      case 'action': {
        const missing = current.requires.filter((f) => !present.has(f));
        if (missing.length > 0) {
          return { ok: false, path, failedAt: current.id, missingFields: missing };
        }
        for (const f of current.produces) present.add(f);
        current = nodeById.get(current.next)!;
        break;
      }
    }
  }
}
