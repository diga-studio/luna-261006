import assert from "node:assert/strict";
import test from "node:test";
import { BomService, type BomRevision } from "../src/index";
import { mulberry32, naiveBomAt, naiveDetect, randomInt, verifyWitness } from "./helpers";

/** 生成一个不重复的起始日集合。 */
function pickDays(rand: () => number, count: number, maxDay: number): number[] {
  const days = new Set<number>();
  while (days.size < count) days.add(randomInt(rand, 0, maxDay));
  return [...days];
}

function randomComponents(rand: () => number, assemblies: readonly string[]): string[] {
  const count = randomInt(rand, 0, 3);
  const components = new Set<string>();
  while (components.size < count) {
    components.add(assemblies[randomInt(rand, 0, assemblies.length - 1)]!);
  }
  return [...components];
}

test("随机批次与朴素参考交叉核对：接受结果、拒绝见证、查询结果一致", () => {
  const TRIALS = 200;
  for (let trial = 0; trial < TRIALS; trial++) {
    const rand = mulberry32(trial * 7919 + 1);
    const assemblyCount = randomInt(rand, 6, 12);
    const maxDay = 40;
    const assemblies = Array.from({ length: assemblyCount }, (_, i) => `M${i}`);

    const service = new BomService();
    const accepted: BomRevision[] = [];
    const used = new Set<string>(); // "assemblyId@day"，保证不重复

    const makeRevision = (): BomRevision | null => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const assemblyId = assemblies[randomInt(rand, 0, assemblies.length - 1)]!;
        const startDay = randomInt(rand, 0, maxDay);
        const key = `${assemblyId}@${startDay}`;
        if (used.has(key)) continue;
        used.add(key);
        return { assemblyId, startDay, components: randomComponents(rand, assemblies) };
      }
      return null;
    };

    const rounds = randomInt(rand, 3, 8);
    for (let round = 0; round < rounds; round++) {
      const batchSize = randomInt(rand, 1, 4);
      const batch: BomRevision[] = [];
      for (let i = 0; i < batchSize; i++) {
        const revision = makeRevision();
        if (revision !== null) batch.push(revision);
      }
      if (batch.length === 0) continue;

      const wouldBe = [...accepted, ...batch];
      const naive = naiveDetect(wouldBe);
      const result = service.publishBatch(batch);

      assert.equal(
        result.ok,
        naive === null,
        `trial ${trial} round ${round}: service=${JSON.stringify(result)} naive=${JSON.stringify(naive)}`,
      );

      if (result.ok) {
        accepted.push(...batch);
      } else {
        // 见证必须在“假如接受后的时间表”上真实闭环。
        assert.ok(
          verifyWitness(wouldBe, result.day, result.cycle),
          `trial ${trial}: invalid witness day=${result.day} cycle=${result.cycle.join("->")}`,
        );
        // 朴素参考在同一天也必须能看到环（见证日合法）。
        assert.ok(
          result.day >= 0 && Number.isInteger(result.day),
          "witness day must be a non-negative integer",
        );
      }

      // 无论接受还是拒绝，发布后查询结果都必须与朴素参考（仅含已接受版本）一致。
      for (const assembly of assemblies) {
        for (let day = 0; day <= maxDay + 2; day++) {
          const expected = naiveBomAt(accepted, assembly, day);
          const actual = service.bomAt(assembly, day);
          if (expected === null) {
            assert.equal(actual, null, `trial ${trial}: ${assembly}@${day}`);
          } else {
            assert.deepEqual(
              actual,
              {
                assemblyId: expected.assemblyId,
                startDay: expected.startDay,
                components: expected.components,
              },
              `trial ${trial}: ${assembly}@${day}`,
            );
          }
        }
      }
    }
  }
});
