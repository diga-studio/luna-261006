import { Fraction, frac, add, mul, div, cmp, floorBig, ceilBig, roundHalfUp } from "./fraction";
import { FlowEdge, feasibleFlow } from "./flow";
import { SettleInput, SettleResult, SettledItem } from "./types";

export { SettleInput, SettleResult, SettledItem, WorkItem } from "./types";

function assertNonNegativeInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${what} 必须是非负整数，收到 ${value}`);
  }
}

/**
 * 周期结算：
 * 1. 未封顶份额 u = P * w_i / Σw，w_i = n - i + 1；
 * 2. 作者×指标组合若 S > C，则该组合所有份额同乘 C/S（扣下的积分不转让）；
 * 3. 在“成果行、作者×指标列、指标总计”三层汇总约束下，把精确份额 x
 *    整数化为 z（每格只取 floor/ceil），用带下界可行流整体求解，
 *    保证不会因逐项舍入让作者超限或凭空增分。
 */
export function settle(input: SettleInput): SettleResult {
  const items = input.items ?? [];
  const caps = input.caps ?? {};

  for (const item of items) {
    assertNonNegativeInteger(item.budget, `成果 ${item.id} 的预算`);
    if (item.authors.length === 0) {
      throw new Error(`成果 ${item.id} 没有署名作者`);
    }
    if (new Set(item.authors).size !== item.authors.length) {
      throw new Error(`成果 ${item.id} 的作者列表存在重复`);
    }
  }
  for (const [author, byMetric] of Object.entries(caps)) {
    for (const [metric, cap] of Object.entries(byMetric)) {
      assertNonNegativeInteger(cap, `作者 ${author} 在指标 ${metric} 的上限`);
    }
  }

  // 第 1 步：未封顶份额 u
  const uncapped: Fraction[][] = items.map((item) => {
    const n = item.authors.length;
    const weightSum = (n * (n + 1)) / 2;
    return item.authors.map((_, idx) =>
      frac(item.budget * (n - idx), weightSum),
    );
  });

  // 第 2 步：按作者×指标组合封顶，得到精确份额 x
  const pairKey = (author: string, metric: string) => `${author}${metric}`;
  const pairSum = new Map<string, Fraction>();
  items.forEach((item, i) => {
    item.authors.forEach((author, k) => {
      const key = pairKey(author, item.metric);
      pairSum.set(key, add(pairSum.get(key) ?? frac(0), uncapped[i]![k]!));
    });
  });

  const scale = new Map<string, Fraction>();
  for (const [key, sum] of pairSum) {
    const [author, metric] = key.split("");
    const cap = caps[author!]?.[metric!];
    if (cap !== undefined && cmp(sum, frac(cap)) > 0) {
      scale.set(key, div(frac(cap), sum));
    }
  }

  const x: Fraction[][] = items.map((item, i) =>
    item.authors.map((author, k) => {
      const factor = scale.get(pairKey(author, item.metric));
      return factor ? mul(uncapped[i]![k]!, factor) : uncapped[i]![k]!;
    }),
  );

  // 第 3 步：三层汇总约束下的整体整数化（带下界可行循环流）
  const pairKeys: string[] = [];
  const pairIndex = new Map<string, number>();
  const metricIndex = new Map<string, number>();
  for (const item of items) {
    if (!metricIndex.has(item.metric)) {
      metricIndex.set(item.metric, metricIndex.size);
    }
    for (const author of item.authors) {
      const key = pairKey(author, item.metric);
      if (!pairIndex.has(key)) {
        pairIndex.set(key, pairKeys.length);
        pairKeys.push(key);
      }
    }
  }

  const m = items.length;
  const p = pairKeys.length;
  const q = metricIndex.size;
  const SOURCE = 0;
  const itemNode = (i: number) => 1 + i;
  const pairNode = (j: number) => 1 + m + j;
  const metricNode = (l: number) => 1 + m + p + l;
  const SINK = 1 + m + p + q;
  const nodeCount = SINK + 1;

  const edges: FlowEdge[] = [];
  // source -> 成果：成果行和只能取 floor/ceil
  const itemTotals: Fraction[] = [];
  items.forEach((_, i) => {
    const total = x[i]!.reduce((acc, v) => add(acc, v), frac(0));
    itemTotals.push(total);
    edges.push({
      from: SOURCE,
      to: itemNode(i),
      lower: floorBig(total),
      upper: ceilBig(total),
    });
  });
  // 成果 -> 作者×指标：每格只能取 floor/ceil
  const cellEdge: number[][] = [];
  items.forEach((item, i) => {
    cellEdge.push([]);
    item.authors.forEach((author, k) => {
      const cell = x[i]![k]!;
      cellEdge[i]!.push(edges.length);
      edges.push({
        from: itemNode(i),
        to: pairNode(pairIndex.get(pairKey(author, item.metric))!),
        lower: floorBig(cell),
        upper: ceilBig(cell),
      });
    });
  });
  // 作者×指标 -> 指标：列和只能取 floor/ceil（封顶后列和 <= C，故 ceil 也不会超 C）
  pairKeys.forEach((key, j) => {
    const metric = key.split("")[1]!;
    let total = frac(0);
    items.forEach((item, i) => {
      item.authors.forEach((author, k) => {
        if (pairKey(author, item.metric) === key) {
          total = add(total, x[i]![k]!);
        }
      });
    });
    edges.push({
      from: pairNode(j),
      to: metricNode(metricIndex.get(metric)!),
      lower: floorBig(total),
      upper: ceilBig(total),
    });
  });
  // 指标 -> sink：指标总和必须等于四舍五入（半单位向上）后的值，指标间不借分
  for (const [metric, l] of metricIndex) {
    let total = frac(0);
    items.forEach((item, i) => {
      if (item.metric === metric) {
        for (const cell of x[i]!) total = add(total, cell);
      }
    });
    const rounded = roundHalfUp(total);
    edges.push({ from: metricNode(l), to: SINK, lower: rounded, upper: rounded });
  }
  // sink -> source：化普通流为循环流
  const grandUpper = itemTotals.reduce((acc, t) => acc + ceilBig(t), 0n);
  edges.push({ from: SINK, to: SOURCE, lower: 0n, upper: grandUpper });

  const flows = feasibleFlow(nodeCount, edges);
  if (flows === null) {
    throw new Error("结算约束不可行：无法在三层汇总约束下完成整数化");
  }

  const result: SettledItem[] = items.map((item, i) => {
    const allocations: Record<string, number> = {};
    item.authors.forEach((author, k) => {
      allocations[author] = Number(flows[cellEdge[i]![k]!]!);
    });
    return { id: item.id, allocations };
  });
  return { items: result };
}
