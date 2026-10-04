import assert from "node:assert/strict";
import test from "node:test";
import { BomService, type BomRevision } from "../src/index";
import { naiveBomAt, verifyWitness } from "./helpers";

const LEVELS = 20;
const PER_LEVEL = 500;
const VERSIONS_EACH = 5;
const DAY_SPACE = 20_000;

function assemblyId(level: number, n: number): string {
  return `L${level}N${n}`;
}

/** 构造 20 层反复分支汇合的稀疏时间表：10k 物料、50k 版本、95k 明细、20k 起始日。 */
function buildLargeTimeline(): BomRevision[] {
  const revisions: BomRevision[] = [];
  for (let i = 0; i < LEVELS * PER_LEVEL; i++) {
    const level = Math.floor(i / PER_LEVEL);
    const n = i % PER_LEVEL;
    for (let j = 0; j < VERSIONS_EACH; j++) {
      const startDay = (i * VERSIONS_EACH + j) % DAY_SPACE;
      const components: string[] = [];
      if (level < LEVELS - 1) {
        components.push(assemblyId(level + 1, (n * 2 + j) % PER_LEVEL));
        components.push(assemblyId(level + 1, (n * 2 + j + 1) % PER_LEVEL));
      }
      revisions.push({ assemblyId: assemblyId(level, n), startDay, components });
    }
  }
  return revisions;
}

test("规模：10k 物料 / 50k 版本 / 95k 明细 / 20k 起始日的稀疏时间表", () => {
  const revisions = buildLargeTimeline();
  assert.equal(revisions.length, 50_000);
  assert.equal(new Set(revisions.map((r) => r.assemblyId)).size, 10_000);
  assert.equal(new Set(revisions.map((r) => r.startDay)).size, DAY_SPACE);
  assert.equal(
    revisions.reduce((sum, r) => sum + r.components.length, 0),
    95_000,
  );

  const service = new BomService();
  const accepted: BomRevision[] = [];
  const started = Date.now();

  // 分 50 个批次发布，静态图为 DAG（只指向下一层），任何一天都不可能成环。
  const BATCH = 1000;
  for (let from = 0; from < revisions.length; from += BATCH) {
    const batch = revisions.slice(from, from + BATCH);
    const result = service.publishBatch(batch);
    assert.equal(result.ok, true, `batch starting at ${from} should be accepted`);
    accepted.push(...batch);
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 60_000, `publishing took ${elapsed}ms`);

  // 抽样与朴素参考核对查询结果。
  for (let i = 0; i < accepted.length; i += 997) {
    const revision = accepted[i]!;
    for (const day of [revision.startDay, revision.startDay + 1, DAY_SPACE + 5]) {
      const expected = naiveBomAt(accepted, revision.assemblyId, day);
      const actual = service.bomAt(revision.assemblyId, day);
      if (expected === null) {
        assert.equal(actual, null);
      } else {
        assert.deepEqual(actual, {
          assemblyId: expected.assemblyId,
          startDay: expected.startDay,
          components: expected.components,
        });
      }
    }
  }
});

test("规模结构上的确定性链：跨 20 层的延迟闭环必须拒绝，提前断开必须接受", () => {
  const service = new BomService();
  // C0 -> C1 -> ... -> C19 从第 1,000,000 天起生效。
  const chain: BomRevision[] = [];
  for (let i = 0; i < 20; i++) {
    chain.push({
      assemblyId: `C${i}`,
      startDay: 1_000_000,
      components: i < 19 ? [`C${i + 1}`] : [],
    });
  }
  assert.equal(service.publishBatch(chain).ok, true);

  // C19 -> C0 只在 [500_000, 1_000_000) 生效：链尚未接通，必须接受。
  assert.equal(
    service.publishBatch([
      { assemblyId: "C19", startDay: 500_000, components: ["C0"] },
      { assemblyId: "C19", startDay: 1_000_000, components: [] },
    ]).ok,
    true,
  );

  // C19 -> C0 从第 2,000,000 天起持续生效：与链同时成立，必须拒绝。
  const poison: BomRevision = { assemblyId: "C19", startDay: 2_000_000, components: ["C0"] };
  const result = service.publishBatch([poison]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.day >= 2_000_000, `witness day ${result.day} should be >= 2_000_000`);
  const wouldBe = [
    ...chain,
    { assemblyId: "C19", startDay: 500_000, components: ["C0"] },
    { assemblyId: "C19", startDay: 1_000_000, components: [] },
    poison,
  ];
  assert.ok(
    verifyWitness(wouldBe, result.day, result.cycle),
    `cycle ${result.cycle.join("->")} should close on day ${result.day}`,
  );
  assert.equal(result.cycle.length, 21, "cycle should span all 20 levels");
  // 拒绝后 C19 在 2,000,000 天仍是空 BOM。
  assert.deepEqual(service.bomAt("C19", 2_000_000), {
    assemblyId: "C19",
    startDay: 1_000_000,
    components: [],
  });
});
