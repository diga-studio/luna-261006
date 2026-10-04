import assert from "node:assert/strict";
import test from "node:test";
import { BomService, type BomRevision } from "../src/index";
import { verifyWitness } from "./helpers";

test("分时反向装配：A 白天引用 B、第 20 天清空，B 第 20 天起引用 A，必须接受", () => {
  const service = new BomService();
  const result = service.publishBatch([
    { assemblyId: "A", startDay: 10, components: ["B"] },
    { assemblyId: "A", startDay: 20, components: [] },
    { assemblyId: "B", startDay: 20, components: ["A"] },
  ]);
  assert.deepEqual(result, { ok: true });

  assert.deepEqual(service.bomAt("A", 9), null);
  assert.deepEqual(service.bomAt("A", 10), { assemblyId: "A", startDay: 10, components: ["B"] });
  assert.deepEqual(service.bomAt("A", 19), { assemblyId: "A", startDay: 10, components: ["B"] });
  assert.deepEqual(service.bomAt("A", 20), { assemblyId: "A", startDay: 20, components: [] });
  assert.deepEqual(service.bomAt("B", 19), null);
  assert.deepEqual(service.bomAt("B", 20), { assemblyId: "B", startDay: 20, components: ["A"] });
  assert.deepEqual(service.bomAt("B", 1_000_000_000), {
    assemblyId: "B",
    startDay: 20,
    components: ["A"],
  });
});

test("环在更晚的已有版本生效时才闭合：必须拒绝并给出有效见证", () => {
  const service = new BomService();
  const setup: BomRevision[] = [{ assemblyId: "B", startDay: 30, components: ["A"] }];
  assert.equal(service.publishBatch(setup).ok, true);

  // A 从第 10 天起持续引用 B：第 30 天 B->A 生效后，A->B->A 成环。
  const batch: BomRevision[] = [{ assemblyId: "A", startDay: 10, components: ["B"] }];
  const result = service.publishBatch(batch);
  assert.equal(result.ok, false);
  if (result.ok) return;

  // 见证日必须 >= 30（第 30 天前 B 没有生效版本，不可能成环）。
  assert.ok(result.day >= 30, `witness day ${result.day} should be >= 30`);
  // 用“假如接受后的时间表”验证见证路径在报告日确实闭环。
  assert.ok(
    verifyWitness([...setup, ...batch], result.day, result.cycle),
    `cycle ${result.cycle.join("->")} should close on day ${result.day}`,
  );
  assert.deepEqual(result.cycle, ["A", "B", "A"]);

  // 拒绝后原时间表完全不变。
  assert.deepEqual(service.bomAt("A", 10), null);
  assert.deepEqual(service.bomAt("B", 30), { assemblyId: "B", startDay: 30, components: ["A"] });
});

test("同批次同一天清空 A 并让 B 引用 A：两种输入顺序都必须成功", () => {
  const clear: BomRevision = { assemblyId: "A", startDay: 50, components: [] };
  const reverse: BomRevision = { assemblyId: "B", startDay: 50, components: ["A"] };
  for (const order of [
    [clear, reverse],
    [reverse, clear],
  ]) {
    const service = new BomService();
    assert.equal(
      service.publishBatch([{ assemblyId: "A", startDay: 10, components: ["B"] }]).ok,
      true,
    );
    const result = service.publishBatch([...order]);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(service.bomAt("A", 50), { assemblyId: "A", startDay: 50, components: [] });
    assert.deepEqual(service.bomAt("B", 50), {
      assemblyId: "B",
      startDay: 50,
      components: ["A"],
    });
  }
});

test("批次整体拒绝：无关合法变更也不得可见", () => {
  const service = new BomService();
  const setup: BomRevision[] = [
    { assemblyId: "A", startDay: 10, components: ["B"] },
    { assemblyId: "B", startDay: 20, components: ["A"] },
  ];
  // 第 10~19 天 A->B 单向，第 20 天起 B->A 而 A 仍引用 B：第 20 天起成环。
  // 先让 A 在第 20 天清空，使当前时间表合法。
  assert.equal(
    service.publishBatch([...setup, { assemblyId: "A", startDay: 20, components: [] }]).ok,
    true,
  );

  const unrelated: BomRevision = { assemblyId: "X", startDay: 5, components: ["Y"] };
  const poison: BomRevision = { assemblyId: "A", startDay: 30, components: ["B"] };
  // 第 30 天起 A->B 与 B->A 同时生效，批次必须整体拒绝。
  const result = service.publishBatch([unrelated, poison]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(verifyWitness([...setup, { assemblyId: "A", startDay: 20, components: [] }, unrelated, poison], result.day, result.cycle));

  // 无关变更不可见，已有时间表不变。
  assert.deepEqual(service.bomAt("X", 5), null);
  assert.deepEqual(service.bomAt("X", 100), null);
  assert.deepEqual(service.bomAt("A", 30), { assemblyId: "A", startDay: 20, components: [] });
  assert.deepEqual(service.bomAt("B", 30), { assemblyId: "B", startDay: 20, components: ["A"] });
});

test("插入两个已有版本之间会缩短前者的有效窗", () => {
  const service = new BomService();
  assert.equal(
    service.publishBatch([
      { assemblyId: "A", startDay: 10, components: ["B"] },
      { assemblyId: "A", startDay: 100, components: ["C"] },
    ]).ok,
    true,
  );
  assert.equal(
    service.publishBatch([{ assemblyId: "A", startDay: 50, components: ["D"] }]).ok,
    true,
  );
  assert.deepEqual(service.bomAt("A", 49), { assemblyId: "A", startDay: 10, components: ["B"] });
  assert.deepEqual(service.bomAt("A", 50), { assemblyId: "A", startDay: 50, components: ["D"] });
  assert.deepEqual(service.bomAt("A", 99), { assemblyId: "A", startDay: 50, components: ["D"] });
  assert.deepEqual(service.bomAt("A", 100), { assemblyId: "A", startDay: 100, components: ["C"] });
});

test("自引用立即成环，必须拒绝", () => {
  const service = new BomService();
  const result = service.publishBatch([{ assemblyId: "A", startDay: 0, components: ["A"] }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.day, 0);
  assert.deepEqual(result.cycle, ["A", "A"]);
  assert.deepEqual(service.bomAt("A", 0), null);
});

test("相隔数十亿天的版本", () => {
  const service = new BomService();
  assert.equal(
    service.publishBatch([
      { assemblyId: "A", startDay: 0, components: ["B"] },
      { assemblyId: "A", startDay: 2_000_000_000, components: [] },
      { assemblyId: "B", startDay: 2_000_000_000, components: ["A"] },
    ]).ok,
    true,
  );
  assert.deepEqual(service.bomAt("A", 1_999_999_999), {
    assemblyId: "A",
    startDay: 0,
    components: ["B"],
  });
  assert.deepEqual(service.bomAt("B", 2_000_000_000), {
    assemblyId: "B",
    startDay: 2_000_000_000,
    components: ["A"],
  });
});
