import { test } from 'node:test';
import type { FlowDefinition, FlowNode } from '../src/index.js';
import { assertMatchesBruteForce } from './helpers.js';

/** 可复现的伪随机数生成器。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成合法随机流程：节点按拓扑序编号，边只指向更后的节点，
 * 且保证主干链 for 每个节点可达。
 */
function randomFlow(seed: number): FlowDefinition {
  const rand = mulberry32(seed);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  const switchCount = 1 + Math.floor(rand() * 4);
  const fieldCount = 1 + Math.floor(rand() * 4);
  const switches = Array.from({ length: switchCount }, (_, i) => `s${i}`);
  const fields = Array.from({ length: fieldCount }, (_, i) => `f${i}`);

  const middleCount = 2 + Math.floor(rand() * 8); // 2..9 个中间节点
  const kinds: ('condition' | 'action')[] = Array.from({ length: middleCount }, () =>
    rand() < 0.5 ? 'condition' : 'action',
  );

  const nodes: FlowNode[] = [];
  const idOf = (i: number) => (i <= middleCount ? `n${i}` : 'end');
  nodes.push({ id: 'n0', kind: 'entry', next: 'n1' });
  for (let i = 1; i <= middleCount; i++) {
    const id = idOf(i);
    if (kinds[i - 1] === 'condition') {
      // 一条边保证主干可达，另一条随机指向更后的节点。
      const onTrue = idOf(i + 1);
      const jump = i + 1 + Math.floor(rand() * (middleCount - i + 1));
      const onFalse = idOf(jump);
      nodes.push({ id, kind: 'condition', switch: pick(switches), onTrue, onFalse });
    } else {
      const requires = fields.filter(() => rand() < 0.4);
      const produces = fields.filter(() => rand() < 0.5);
      nodes.push({ id, kind: 'action', requires, produces, next: idOf(i + 1) });
    }
  }
  nodes.push({ id: 'end', kind: 'end' });
  return { switches, fields, nodes };
}

test('随机小流程：报告集合与暴力枚举完全一致（300 个种子）', () => {
  for (let seed = 1; seed <= 300; seed++) {
    assertMatchesBruteForce(randomFlow(seed));
  }
});
