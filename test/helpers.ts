import { analyzeFlow, replayFlow } from '../src/index';
import type { FlowDefinition, FlowNode, NodeId } from '../src/index';

/** Deterministic PRNG (mulberry32) for reproducible random flows. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomFlowOptions {
  middleNodes: number;
  switchCount: number;
  fields: string[];
  endNodes?: number;
}

/**
 * Generates a valid random DAG flow: single entry, forward edges only,
 * ends only in trailing positions, every path terminates at an end.
 */
export function randomFlow(rng: () => number, opts: RandomFlowOptions): FlowDefinition {
  const { middleNodes, switchCount, fields } = opts;
  const endCount = opts.endNodes ?? 1;
  const total = 1 + middleNodes + endCount;
  const pick = (n: number) => Math.floor(rng() * n);
  const laterPosition = (from: number) => from + 1 + pick(total - from - 1);
  const idOf = (pos: number) => `n${pos}`;

  const nodes: FlowNode[] = [];
  for (let pos = 0; pos < total; pos++) {
    if (pos === 0) {
      nodes.push({ id: idOf(pos), kind: 'entry', next: idOf(1) });
    } else if (pos >= total - endCount) {
      nodes.push({ id: idOf(pos), kind: 'end' });
    } else {
      const isCondition = rng() < 0.4;
      if (isCondition) {
        const onTrue = rng() < 0.7 ? pos + 1 : laterPosition(pos);
        const onFalse = rng() < 0.15 ? onTrue : laterPosition(pos);
        nodes.push({
          id: idOf(pos),
          kind: 'condition',
          switchIndex: pick(switchCount),
          onTrue: idOf(onTrue),
          onFalse: idOf(onFalse),
        });
      } else {
        const requires = fields.filter(() => rng() < 0.35);
        const produces = fields.filter(() => rng() < 0.45);
        const next = rng() < 0.7 ? pos + 1 : laterPosition(pos);
        nodes.push({ id: idOf(pos), kind: 'action', requires, produces, next: idOf(next) });
      }
    }
  }
  return { switchCount, nodes };
}

/** All 2^switchCount complete inputs, as boolean arrays. */
export function allInputs(switchCount: number): boolean[][] {
  const inputs: boolean[][] = [];
  for (let mask = 0; mask < 1 << switchCount; mask++) {
    const input: boolean[] = [];
    for (let bit = 0; bit < switchCount; bit++) input.push(((mask >>> bit) & 1) === 1);
    inputs.push(input);
  }
  return inputs;
}

export const comboKey = (nodeId: NodeId, field: string) => `${nodeId}|${field}`;

/**
 * Oracle: enumerates every switch input, replays it, and collects the
 * truly reachable first-failure (node, field) combinations.
 */
export function bruteForceCombos(flow: FlowDefinition): Set<string> {
  const combos = new Set<string>();
  for (const input of allInputs(flow.switchCount)) {
    const result = replayFlow(flow, input);
    if (!result.ok) {
      for (const field of result.missingFields) combos.add(comboKey(result.failedNode, field));
    }
  }
  return combos;
}

/** (node, field) combinations reported by the symbolic analysis. */
export function analyzedCombos(flow: FlowDefinition): Set<string> {
  const result = analyzeFlow(flow);
  return new Set(result.reports.map((r) => comboKey(r.nodeId, r.field)));
}
