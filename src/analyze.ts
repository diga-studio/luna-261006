import { createBddManager, type BddNode } from './bdd.js';
import type { AnalysisResult, FlowDefinition, FlowNode, NodeId, RiskReport } from './types.js';

/**
 * 发布前数据就绪检查。
 *
 * 思路：开关只读、字段只增，因此对每个节点 n 与字段 f 可以精确维护两个
 * 布尔函数（以开关赋值为论域，用 BDD 表示）：
 *   P_n    —— 存在某条无更早失败的执行到达 n 的赋值集合；
 *   A_n[f] —— 上述执行中到达 n 时字段 f 已存在的赋值集合。
 * 动作 n 的必填字段 f 构成首次失败风险，当且仅当 P_n ∧ ¬A_n[f] 可满足；
 * 满足该式的任一赋值即真实触发该首次失败的完整输入。
 */
export function analyzeFlow(flow: FlowDefinition): AnalysisResult {
  const mgr = createBddManager(flow.switches.length);
  const nodeById = new Map<NodeId, FlowNode>(flow.nodes.map((n) => [n.id, n]));
  const switchIndex = new Map(flow.switches.map((name, i) => [name, i]));
  const fieldIndex = new Map(flow.fields.map((name, i) => [name, i]));
  const fieldCount = flow.fields.length;

  interface Edge {
    to: NodeId;
    lit: BddNode;
  }
  const successors = new Map<NodeId, Edge[]>();
  const indegree = new Map<NodeId, number>();
  for (const n of flow.nodes) {
    const outs: Edge[] = [];
    if (n.kind === 'entry' || n.kind === 'action') {
      outs.push({ to: n.next, lit: mgr.one });
    } else if (n.kind === 'condition') {
      const si = switchIndex.get(n.switch)!;
      outs.push({ to: n.onTrue, lit: mgr.literal(si, true) });
      outs.push({ to: n.onFalse, lit: mgr.literal(si, false) });
    }
    successors.set(n.id, outs);
    for (const e of outs) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }

  // 拓扑序（输入为 DAG）。
  const order: FlowNode[] = [];
  const queue: FlowNode[] = flow.nodes.filter((n) => !indegree.has(n.id));
  for (let head = 0; head < queue.length; head++) {
    const n = queue[head];
    order.push(n);
    for (const e of successors.get(n.id)!) {
      const d = indegree.get(e.to)! - 1;
      indegree.set(e.to, d);
      if (d === 0) queue.push(nodeById.get(e.to)!);
    }
  }

  const P = new Map<NodeId, BddNode>();
  const A = new Map<NodeId, BddNode[]>();
  for (const n of flow.nodes) {
    P.set(n.id, mgr.zero);
    A.set(n.id, new Array<BddNode>(fieldCount).fill(mgr.zero));
  }
  const entry = flow.nodes.find((n) => n.kind === 'entry');
  if (!entry) throw new Error('flow has no entry node');
  P.set(entry.id, mgr.one);

  const reports: RiskReport[] = [];

  for (const n of order) {
    const Pn = P.get(n.id)!;
    if (Pn === mgr.zero) continue;
    const An = A.get(n.id)!;

    let pass: BddNode;
    let after: BddNode[];
    if (n.kind === 'action') {
      pass = Pn;
      for (const f of n.requires) {
        const fi = fieldIndex.get(f)!;
        const risk = mgr.and(Pn, mgr.not(An[fi]));
        if (risk !== mgr.zero) {
          reports.push({ nodeId: n.id, field: f, witness: mgr.satOne(risk)! });
        }
        pass = mgr.and(pass, An[fi]);
      }
      after = An.slice();
      for (const f of n.produces) after[fieldIndex.get(f)!] = mgr.one;
      for (let i = 0; i < fieldCount; i++) {
        if (after[i] !== mgr.zero) after[i] = mgr.and(pass, after[i]);
      }
    } else {
      pass = Pn;
      after = An;
    }

    for (const e of successors.get(n.id)!) {
      const edgeP = mgr.and(e.lit, pass);
      if (edgeP === mgr.zero) continue;
      P.set(e.to, mgr.or(P.get(e.to)!, edgeP));
      const Ato = A.get(e.to)!;
      for (let i = 0; i < fieldCount; i++) {
        if (after[i] === mgr.zero) continue;
        const contrib = mgr.and(e.lit, after[i]);
        if (contrib !== mgr.zero) Ato[i] = mgr.or(Ato[i], contrib);
      }
    }
  }

  return { reports };
}
