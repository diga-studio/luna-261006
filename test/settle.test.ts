import test from "node:test";
import assert from "node:assert/strict";
import { settle } from "../src/index";
import type { SettleOutput } from "../src/index";

function totalOf(out: SettleOutput): number {
  return out.reduce((s, w) => s + Object.values(w.shares).reduce((a, b) => a + b, 0), 0);
}

function authorTotal(out: SettleOutput, author: string): number {
  return out.reduce((s, w) => s + (w.shares[author] ?? 0), 0);
}

function workTotal(out: SettleOutput, workId: string): number {
  const w = out.find((x) => x.workId === workId);
  return Object.values(w!.shares).reduce((a, b) => a + b, 0);
}

test("同一指标 3 项预算为 1 的成果，A 封顶 1", () => {
  const out = settle({
    works: [
      { id: "w1", indicator: "K", budget: 1, authors: ["A", "B"] },
      { id: "w2", indicator: "K", budget: 1, authors: ["A", "B"] },
      { id: "w3", indicator: "K", budget: 1, authors: ["A", "B"] },
    ],
    caps: [
      { author: "A", indicator: "K", cap: 1 },
      { author: "B", indicator: "K", cap: 3 },
    ],
  });
  // x_A = x_B = 1/3（A 由 2/3 封顶缩到 1/3），指标合计 X = 2。
  assert.equal(totalOf(out), 2);
  assert.equal(authorTotal(out, "A"), 1);
  assert.equal(authorTotal(out, "B"), 1);
  for (const id of ["w1", "w2", "w3"]) {
    const t = workTotal(out, id);
    assert.ok(t === 0 || t === 1, "任一成果最多分出 1");
  }
  for (const w of out) {
    for (const [author, z] of Object.entries(w.shares)) {
      assert.ok(["A", "B"].includes(author), "未署名作者不得分积分");
      assert.ok(z === 0 || z === 1, "x=1/3 只能取 0 或 1");
    }
  }
});

test("多个作者同时触顶，精确份额位于半单位两侧", () => {
  // W3: P=10 [D,E,F] 未封顶 5, 10/3, 5/3；W4: P=4 [D,E] 未封顶 8/3, 4/3。
  // D: S=23/3 封顶 4 → x_D3=60/23≈2.609, x_D4=32/23≈1.391（半单位两侧）。
  // E: S=14/3 封顶 3 → x_E3=15/7≈2.143, x_E4=6/7≈0.857。F 不封顶：x_F3=5/3。
  const out = settle({
    works: [
      { id: "w3", indicator: "K2", budget: 10, authors: ["D", "E", "F"] },
      { id: "w4", indicator: "K2", budget: 4, authors: ["D", "E"] },
    ],
    caps: [
      { author: "D", indicator: "K2", cap: 4 },
      { author: "E", indicator: "K2", cap: 3 },
      { author: "F", indicator: "K2", cap: 100 },
    ],
  });
  // 组合层面：D、E 恰好顶到上限。
  assert.equal(authorTotal(out, "D"), 4);
  assert.equal(authorTotal(out, "E"), 3);
  // 指标合计 X = 3100/483 + 362/161 = 4186/483 ≈ 8.666 → 9。
  assert.equal(totalOf(out), 9);
  // F 的合计被指标总量唯一确定为 ceil(5/3) = 2。
  assert.equal(authorTotal(out, "F"), 2);
  // 成果层面：Σx_w3 ≈ 6.418 → {6,7}；Σx_w4 ≈ 2.248 → {2,3}。
  assert.ok([6, 7].includes(workTotal(out, "w3")));
  assert.ok([2, 3].includes(workTotal(out, "w4")));
  // 单元格层面：每个 z 只能是对应 x 的向下或向上取整。
  const w3 = out.find((w) => w.workId === "w3")!.shares;
  const w4 = out.find((w) => w.workId === "w4")!.shares;
  assert.ok([2, 3].includes(w3.D!)); // 2.609
  assert.ok([1, 2].includes(w4.D!)); // 1.391
  assert.ok([2, 3].includes(w3.E!)); // 2.143
  assert.ok([0, 1].includes(w4.E!)); // 0.857
  assert.ok([1, 2].includes(w3.F!)); // 1.667
  assert.equal(w4.F, undefined, "未署名作者不得分积分");
});

test("恰好半单位的单元格与指标半单位向上取整", () => {
  // P=3 [A,B,C]：未封顶 3/2, 1, 1/2。A 封顶 1 → x_A=1, x_B=1, x_C=1/2。
  // 指标合计 X = 5/2，四舍五入半单位向上 → 3。
  const out = settle({
    works: [{ id: "w1", indicator: "K", budget: 3, authors: ["A", "B", "C"] }],
    caps: [
      { author: "A", indicator: "K", cap: 1 },
      { author: "B", indicator: "K", cap: 10 },
      { author: "C", indicator: "K", cap: 10 },
    ],
  });
  assert.equal(totalOf(out), 3);
  assert.deepEqual(out[0]!.shares, { A: 1, B: 1, C: 1 });
});

test("指标合计不足半单位时向下取整", () => {
  // W1: P=1 [A,B]；W2: P=2 [A]。S_A = 8/3 封顶 2 → x_A1=1/2, x_A2=3/2；
  // x_B1 = 1/3。指标合计 X = 7/3 ≈ 2.333 → 2。
  const out = settle({
    works: [
      { id: "w1", indicator: "K", budget: 1, authors: ["A", "B"] },
      { id: "w2", indicator: "K", budget: 2, authors: ["A"] },
    ],
    caps: [
      { author: "A", indicator: "K", cap: 2 },
      { author: "B", indicator: "K", cap: 10 },
    ],
  });
  assert.equal(totalOf(out), 2);
  assert.equal(authorTotal(out, "A"), 2);
  assert.equal(authorTotal(out, "B"), 0);
  assert.equal(out[0]!.shares.B, 0);
});

test("无封顶时按权重取整且总量守恒", () => {
  // P=5 [A,B]：x_A = 10/3, x_B = 5/3，指标合计 5。
  const out = settle({
    works: [{ id: "w1", indicator: "K", budget: 5, authors: ["A", "B"] }],
    caps: [
      { author: "A", indicator: "K", cap: 100 },
      { author: "B", indicator: "K", cap: 100 },
    ],
  });
  assert.equal(totalOf(out), 5);
  const shares = out[0]!.shares;
  assert.ok([3, 4].includes(shares.A!));
  assert.ok([1, 2].includes(shares.B!));
  assert.equal(shares.A! + shares.B!, 5);
});

test("指标之间不得借分", () => {
  // K1 合计 5/2 → 3；K2 合计 1/2 → 1（ceil(1/4)+ceil(1/4) 由组合约束决定）。
  const out = settle({
    works: [
      { id: "w1", indicator: "K1", budget: 3, authors: ["A", "B", "C"] },
      { id: "w2", indicator: "K2", budget: 1, authors: ["A", "B"] },
    ],
    caps: [
      { author: "A", indicator: "K1", cap: 1 },
      { author: "B", indicator: "K1", cap: 10 },
      { author: "C", indicator: "K1", cap: 10 },
      { author: "A", indicator: "K2", cap: 10 },
      { author: "B", indicator: "K2", cap: 10 },
    ],
  });
  assert.equal(workTotal(out, "w1"), 3);
  assert.equal(workTotal(out, "w2"), 1);
  assert.equal(totalOf(out), 4);
});

test("非法输入直接报错", () => {
  assert.throws(() =>
    settle({
      works: [{ id: "w1", indicator: "K", budget: -1, authors: ["A"] }],
      caps: [],
    }),
  );
  assert.throws(() =>
    settle({
      works: [
        { id: "w1", indicator: "K", budget: 1, authors: ["A"] },
        { id: "w1", indicator: "K", budget: 1, authors: ["B"] },
      ],
      caps: [],
    }),
  );
  assert.throws(() =>
    settle({
      works: [{ id: "w1", indicator: "K", budget: 1, authors: ["A", "A"] }],
      caps: [],
    }),
  );
});
