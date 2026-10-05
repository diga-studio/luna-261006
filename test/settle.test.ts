import { test } from "node:test";
import assert from "node:assert";
import { settle } from "../src/settle";
import { SettleInput } from "../src/types";
import {
  Fraction, frac, add, mul, div, cmp, floorBig, ceilBig, roundHalfUp,
} from "../src/fraction";

/** 按题面规则独立重算每个成果到作者的精确份额 x */
function computeExactShares(input: SettleInput): Fraction[][] {
  const uncapped: Fraction[][] = input.items.map((item) => {
    const n = item.authors.length;
    const w = (n * (n + 1)) / 2;
    return item.authors.map((_, i) => frac(item.budget * (n - i), w));
  });
  const sum = new Map<string, Fraction>();
  input.items.forEach((item, i) => {
    item.authors.forEach((a, k) => {
      const key = `${a} @ ${item.metric}`;
      sum.set(key, add(sum.get(key) ?? frac(0), uncapped[i]![k]!));
    });
  });
  return input.items.map((item, i) =>
    item.authors.map((a, k) => {
      const key = `${a} @ ${item.metric}`;
      const cap = input.caps?.[a]?.[item.metric];
      const s = sum.get(key)!;
      if (cap !== undefined && cmp(s, frac(cap)) > 0) {
        return mul(uncapped[i]![k]!, div(frac(cap), s));
      }
      return uncapped[i]![k]!;
    }),
  );
}

/** 校验结算结果满足全部三层汇总约束 */
function assertConstraints(input: SettleInput): void {
  const result = settle(input);
  const x = computeExactShares(input);
  assert.strictEqual(result.items.length, input.items.length);

  const pairZ = new Map<string, bigint>();
  const pairX = new Map<string, Fraction>();
  const metricZ = new Map<string, bigint>();
  const metricX = new Map<string, Fraction>();

  result.items.forEach((out, i) => {
    const item = input.items[i]!;
    assert.strictEqual(out.id, item.id);
    // 没有署名的作者不得获得积分
    for (const name of Object.keys(out.allocations)) {
      assert.ok(item.authors.includes(name), `${item.id} 分给了未署名的 ${name}`);
    }
    let rowZ = 0n;
    let rowX = frac(0);
    item.authors.forEach((a, k) => {
      const z = BigInt(out.allocations[a]!);
      const cell = x[i]![k]!;
      // 每格只能取 floor/ceil
      assert.ok(
        z === floorBig(cell) || z === ceilBig(cell),
        `${item.id}/${a}=${z} 不是 ${cell.n}/${cell.d} 的 floor/ceil`,
      );
      rowZ += z;
      rowX = add(rowX, cell);
      const pkey = `${a} @ ${item.metric}`;
      pairZ.set(pkey, (pairZ.get(pkey) ?? 0n) + z);
      pairX.set(pkey, add(pairX.get(pkey) ?? frac(0), cell));
    });
    // 成果行和只能取 floor/ceil
    assert.ok(
      rowZ === floorBig(rowX) || rowZ === ceilBig(rowX),
      `成果 ${item.id} 行和 ${rowZ} 越界（x 行和 ${rowX.n}/${rowX.d}）`,
    );
    metricZ.set(item.metric, (metricZ.get(item.metric) ?? 0n) + rowZ);
    metricX.set(item.metric, add(metricX.get(item.metric) ?? frac(0), rowX));
  });

  // 作者×指标列和只能取 floor/ceil，且不得超过 C
  for (const [key, z] of pairZ) {
    const sx = pairX.get(key)!;
    assert.ok(
      z === floorBig(sx) || z === ceilBig(sx),
      `组合 ${key} 列和 ${z} 越界（x 列和 ${sx.n}/${sx.d}）`,
    );
    const [author, metric] = key.split(" @ ");
    const cap = input.caps?.[author!]?.[metric!];
    if (cap !== undefined) {
      assert.ok(z <= BigInt(cap), `组合 ${key} 列和 ${z} 超过上限 ${cap}`);
    }
  }

  // 指标总和必须等于四舍五入（半单位向上），指标间不得借分
  for (const [metric, z] of metricZ) {
    const want = roundHalfUp(metricX.get(metric)!);
    assert.strictEqual(z, want, `指标 ${metric} 总和 ${z} != ${want}`);
  }
}

test("题面场景：3 项预算为 1 的成果，A 上限 1、B 上限 3", () => {
  const input: SettleInput = {
    items: [
      { id: "r1", metric: "M", budget: 1, authors: ["A", "B"] },
      { id: "r2", metric: "M", budget: 1, authors: ["A", "B"] },
      { id: "r3", metric: "M", budget: 1, authors: ["A", "B"] },
    ],
    caps: { A: { M: 1 }, B: { M: 3 } },
  };
  const result = settle(input);
  let totalA = 0;
  let totalB = 0;
  for (const item of result.items) {
    const a = item.allocations.A!;
    const b = item.allocations.B!;
    assert.ok(a + b <= 1, `任一成果最多分出 1，实际 ${a + b}`);
    totalA += a;
    totalB += b;
  }
  assert.strictEqual(totalA, 1);
  assert.strictEqual(totalB, 1);
  assert.strictEqual(totalA + totalB, 2);
  assertConstraints(input);
});

test("多个作者同时触顶，精确份额位于半单位两侧", () => {
  const input: SettleInput = {
    items: [
      { id: "r1", metric: "M", budget: 10, authors: ["A", "B", "C"] },
      { id: "r2", metric: "M", budget: 4, authors: ["B", "A"] },
    ],
    caps: { A: { M: 5 }, B: { M: 5 } },
  };
  const result = settle(input);
  const sum = (name: string) =>
    result.items.reduce((acc, it) => acc + (it.allocations[name] ?? 0), 0);
  // A、B 的 x 列和恰好等于上限 5
  assert.strictEqual(sum("A"), 5);
  assert.strictEqual(sum("B"), 5);
  // C 未封顶：x = 5/3，只能取 1 或 2
  assert.ok(sum("C") === 1 || sum("C") === 2);
  // 指标总和 = round(5 + 5 + 5/3) = round(35/3) = 12
  assert.strictEqual(sum("A") + sum("B") + sum("C"), 12);
  assertConstraints(input);
});

test("指标总和恰好半单位时向上取整", () => {
  // x = 1/2, 1/3, 1/6；把 B、C 封到 0 后指标 x 总和恰为 1/2
  const input: SettleInput = {
    items: [{ id: "r1", metric: "M", budget: 1, authors: ["A", "B", "C"] }],
    caps: { B: { M: 0 }, C: { M: 0 } },
  };
  const result = settle(input);
  const alloc = result.items[0]!.allocations;
  assert.strictEqual(alloc.A, 1);
  assert.strictEqual(alloc.B, 0);
  assert.strictEqual(alloc.C, 0);
  assertConstraints(input);
});

test("被扣掉的积分不转给其他作者", () => {
  // A 封到 0：x_A 全部扣掉，指标 x 总和 = 1/3 < 1/2，整体舍为 0
  const input: SettleInput = {
    items: [{ id: "r1", metric: "M", budget: 1, authors: ["A", "B"] }],
    caps: { A: { M: 0 } },
  };
  const result = settle(input);
  assert.strictEqual(result.items[0]!.allocations.A, 0);
  assert.strictEqual(result.items[0]!.allocations.B, 0);
  assertConstraints(input);
});

test("多指标各自结算，指标之间不借分", () => {
  const input: SettleInput = {
    items: [
      { id: "r1", metric: "M1", budget: 1, authors: ["A", "B"] },
      { id: "r2", metric: "M2", budget: 1, authors: ["A", "C"] },
      { id: "r3", metric: "M2", budget: 2, authors: ["C"] },
    ],
    caps: { A: { M1: 0 } },
  };
  const result = settle(input);
  const byMetric = (m: string) =>
    result.items
      .filter((it) => input.items.find((i) => i.id === it.id)!.metric === m)
      .reduce((acc, it) => acc + Object.values(it.allocations).reduce((s, v) => s + v, 0), 0);
  // M1：A 封 0 后 x 总和 1/3 -> 0；M2：x 总和 1 + 2 = 3 -> 3
  assert.strictEqual(byMetric("M1"), 0);
  assert.strictEqual(byMetric("M2"), 3);
  assertConstraints(input);
});

test("空成果列表", () => {
  assert.deepStrictEqual(settle({ items: [] }), { items: [] });
});

test("无上限时退化为普通份额取整", () => {
  const input: SettleInput = {
    items: [{ id: "r1", metric: "M", budget: 10, authors: ["A", "B"] }],
  };
  const result = settle(input);
  const alloc = result.items[0]!.allocations;
  // x_A = 20/3, x_B = 10/3，行和 10
  assert.strictEqual(alloc.A! + alloc.B!, 10);
  assert.ok(alloc.A === 6 || alloc.A === 7);
  assert.ok(alloc.B === 3 || alloc.B === 4);
  assertConstraints(input);
});

test("非法输入报错", () => {
  assert.throws(() =>
    settle({ items: [{ id: "r1", metric: "M", budget: -1, authors: ["A"] }] }),
  );
  assert.throws(() =>
    settle({ items: [{ id: "r1", metric: "M", budget: 1.5, authors: ["A"] }] }),
  );
  assert.throws(() =>
    settle({ items: [{ id: "r1", metric: "M", budget: 1, authors: [] }] }),
  );
  assert.throws(() =>
    settle({ items: [{ id: "r1", metric: "M", budget: 1, authors: ["A", "A"] }] }),
  );
});

// 简单可复现的伪随机数发生器
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

test("随机用例：三层汇总约束恒成立（含可行性压力测试）", () => {
  const rand = mulberry32(20261005);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  for (let caseNo = 0; caseNo < 300; caseNo++) {
    const metrics = ["M1", "M2", "M3"].slice(0, 1 + Math.floor(rand() * 3));
    const authors = ["A", "B", "C", "D", "E"].slice(0, 2 + Math.floor(rand() * 4));
    const itemCount = 1 + Math.floor(rand() * 6);
    const items = Array.from({ length: itemCount }, (_, i) => {
      const n = 1 + Math.floor(rand() * Math.min(authors.length, 4));
      const shuffled = [...authors].sort(() => rand() - 0.5);
      return {
        id: `r${i}`,
        metric: pick(metrics),
        budget: Math.floor(rand() * 20),
        authors: shuffled.slice(0, n),
      };
    });
    const caps: Record<string, Record<string, number>> = {};
    for (const a of authors) {
      for (const m of metrics) {
        if (rand() < 0.6) {
          (caps[a] ??= {})[m] = Math.floor(rand() * 15);
        }
      }
    }
    assertConstraints({ items, caps });
  }
});
