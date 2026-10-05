/**
 * 简化 BDD（二元决策图）：精确表示开关赋值集合上的布尔函数。
 * 变量数 = 开关数（<=40），变量序固定为开关下标序。
 * 节点 0 表示常量 false，节点 1 表示常量 true。
 */

export type BddNode = number;

export interface BddManager {
  readonly varCount: number;
  readonly zero: BddNode;
  readonly one: BddNode;
  /** 单变量函数 x_i（value=true）或 !x_i（value=false）。 */
  literal(varIndex: number, value: boolean): BddNode;
  and(a: BddNode, b: BddNode): BddNode;
  or(a: BddNode, b: BddNode): BddNode;
  not(a: BddNode): BddNode;
  /** 若可满足，返回一组完整赋值（未约束的变量取 false）；否则返回 null。 */
  satOne(a: BddNode): boolean[] | null;
}

export function createBddManager(varCount: number): BddManager {
  const ZERO: BddNode = 0;
  const ONE: BddNode = 1;

  // 节点池：下标即节点 id，0/1 为终端。
  const nodeVar: number[] = [-1, -1];
  const nodeLow: BddNode[] = [ZERO, ZERO];
  const nodeHigh: BddNode[] = [ZERO, ZERO];
  const unique = new Map<string, BddNode>();

  function mk(varIndex: number, low: BddNode, high: BddNode): BddNode {
    if (low === high) return low;
    const key = varIndex + ':' + low + ':' + high;
    const hit = unique.get(key);
    if (hit !== undefined) return hit;
    const id = nodeVar.length;
    nodeVar.push(varIndex);
    nodeLow.push(low);
    nodeHigh.push(high);
    unique.set(key, id);
    return id;
  }

  // op: false=and, true=or
  const applyCache = new Map<string, BddNode>();

  function apply(orOp: boolean, a: BddNode, b: BddNode): BddNode {
    if (orOp) {
      if (a === ONE || b === ONE) return ONE;
      if (a === ZERO) return b;
      if (b === ZERO) return a;
    } else {
      if (a === ZERO || b === ZERO) return ZERO;
      if (a === ONE) return b;
      if (b === ONE) return a;
    }
    if (a === b) return a;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = (orOp ? '1:' : '0:') + lo + ':' + hi;
    const hit = applyCache.get(key);
    if (hit !== undefined) return hit;

    const va = nodeVar[a];
    const vb = nodeVar[b];
    const v = va < vb ? va : vb;
    const aLow = va === v ? nodeLow[a] : a;
    const aHigh = va === v ? nodeHigh[a] : a;
    const bLow = vb === v ? nodeLow[b] : b;
    const bHigh = vb === v ? nodeHigh[b] : b;
    const resLow = apply(orOp, aLow, bLow);
    const resHigh = apply(orOp, aHigh, bHigh);
    const res = mk(v, resLow, resHigh);
    applyCache.set(key, res);
    return res;
  }

  const notCache = new Map<BddNode, BddNode>([[ZERO, ONE], [ONE, ZERO]]);

  function notRec(a: BddNode): BddNode {
    const hit = notCache.get(a);
    if (hit !== undefined) return hit;
    const res = mk(nodeVar[a], notRec(nodeLow[a]), notRec(nodeHigh[a]));
    notCache.set(a, res);
    return res;
  }

  function satOne(a: BddNode): boolean[] | null {
    if (a === ZERO) return null;
    const assignment = new Array<boolean>(varCount).fill(false);
    let cur = a;
    while (cur !== ONE) {
      const v = nodeVar[cur];
      if (nodeLow[cur] !== ZERO) {
        assignment[v] = false;
        cur = nodeLow[cur];
      } else {
        assignment[v] = true;
        cur = nodeHigh[cur];
      }
    }
    return assignment;
  }

  return {
    varCount,
    zero: ZERO,
    one: ONE,
    literal(varIndex, value) {
      return mk(varIndex, value ? ZERO : ONE, value ? ONE : ZERO);
    },
    and(a, b) {
      return apply(false, a, b);
    },
    or(a, b) {
      return apply(true, a, b);
    },
    not(a) {
      return notRec(a);
    },
    satOne,
  };
}
