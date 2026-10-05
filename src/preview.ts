import { explainStudent } from "./explain.js";
import { BASELINE_RULES, scoreOf, tierOf, validateRules } from "./rules.js";
import {
  TIERS,
  type ExplanationCount,
  type IndicatorFlags,
  type PreviewResult,
  type RuleSet,
  type StudentPreview,
  type StudentSnapshot,
  type Tier,
  type TransitionKey,
} from "./types.js";

const PROFILE_COUNT = 64;

function flagsToMask(s: IndicatorFlags): number {
  return (
    (s.gpaBelow2 ? 1 : 0) |
    (s.attendanceBelow75 ? 2 : 0) |
    (s.aidIncomplete ? 4 : 0) |
    (s.undeclaredOver30 ? 8 : 0) |
    (s.withdrew2Plus ? 16 : 0) |
    (s.firstGen ? 32 : 0)
  );
}

function maskToFlags(mask: number): IndicatorFlags {
  return {
    gpaBelow2: (mask & 1) !== 0,
    attendanceBelow75: (mask & 2) !== 0,
    aidIncomplete: (mask & 4) !== 0,
    undeclaredOver30: (mask & 8) !== 0,
    withdrew2Plus: (mask & 16) !== 0,
    firstGen: (mask & 32) !== 0,
  };
}

/**
 * 风险规则预览引擎。学生快照保存在进程内存中；
 * 六维布尔指标只有 64 种画像，预览按画像聚合，
 * 因此预览耗时与学生总数基本无关。
 */
export class RulePreviewEngine {
  readonly #profiles: Uint8Array;
  readonly #indexById: Map<string, number>;
  readonly #countByProfile: Uint32Array;
  readonly #baselineScoreByProfile: Int32Array;
  readonly #baselineTierByProfile: Tier[];

  constructor(students: readonly StudentSnapshot[]) {
    this.#profiles = new Uint8Array(students.length);
    this.#indexById = new Map();
    this.#countByProfile = new Uint32Array(PROFILE_COUNT);
    this.#baselineScoreByProfile = new Int32Array(PROFILE_COUNT);
    this.#baselineTierByProfile = new Array<Tier>(PROFILE_COUNT);

    for (let i = 0; i < students.length; i += 1) {
      const s = students[i];
      if (this.#indexById.has(s.studentId)) {
        throw new Error(`duplicate studentId: ${s.studentId}`);
      }
      const mask = flagsToMask(s);
      this.#profiles[i] = mask;
      this.#indexById.set(s.studentId, i);
      this.#countByProfile[mask] += 1;
    }

    for (let p = 0; p < PROFILE_COUNT; p += 1) {
      const score = scoreOf(maskToFlags(p), BASELINE_RULES);
      this.#baselineScoreByProfile[p] = score;
      this.#baselineTierByProfile[p] = tierOf(score, BASELINE_RULES);
    }
  }

  get baselineRules(): RuleSet {
    return BASELINE_RULES;
  }

  get studentCount(): number {
    return this.#profiles.length;
  }

  /** 完整预览：九种迁移人数 + 各迁移方向下每份解释的人数 */
  preview(candidate: RuleSet): PreviewResult {
    validateRules(candidate);

    const transitions = Object.fromEntries(
      TIERS.map((from) => [from, Object.fromEntries(TIERS.map((to) => [to, 0]))]),
    ) as Record<Tier, Record<Tier, number>>;
    const explanationMaps = new Map<TransitionKey, Map<string, ExplanationCount>>();

    for (let p = 0; p < PROFILE_COUNT; p += 1) {
      const count = this.#countByProfile[p];
      if (count === 0) continue;

      const flags = maskToFlags(p);
      const baselineTier = this.#baselineTierByProfile[p];
      const candidateTier = tierOf(scoreOf(flags, candidate), candidate);
      transitions[baselineTier][candidateTier] += count;
      if (baselineTier === candidateTier) continue;

      const key: TransitionKey = `${baselineTier}->${candidateTier}`;
      let bucket = explanationMaps.get(key);
      if (bucket === undefined) {
        bucket = new Map();
        explanationMaps.set(key, bucket);
      }
      for (const explanation of explainStudent(flags, BASELINE_RULES, candidate, candidateTier)) {
        const label = explanation.parameters.join(",");
        const entry = bucket.get(label);
        if (entry === undefined) {
          bucket.set(label, { parameters: explanation.parameters, count });
        } else {
          entry.count += count;
        }
      }
    }

    const explanations: PreviewResult["explanations"] = {};
    for (const [key, bucket] of explanationMaps) {
      explanations[key] = [...bucket.values()].sort(
        (a, b) => a.parameters.length - b.parameters.length,
      );
    }
    return { transitions, explanations };
  }

  /** 按学号查看该方案下的前后分数、档位与换档解释 */
  previewStudent(candidate: RuleSet, studentId: string): StudentPreview {
    validateRules(candidate);
    const index = this.#indexById.get(studentId);
    if (index === undefined) {
      throw new Error(`unknown studentId: ${studentId}`);
    }
    const mask = this.#profiles[index];
    const flags = maskToFlags(mask);
    const baselineScore = this.#baselineScoreByProfile[mask];
    const baselineTier = this.#baselineTierByProfile[mask];
    const candidateScore = scoreOf(flags, candidate);
    const candidateTier = tierOf(candidateScore, candidate);
    const explanations =
      baselineTier === candidateTier
        ? []
        : explainStudent(flags, BASELINE_RULES, candidate, candidateTier);
    return {
      studentId,
      baselineScore,
      baselineTier,
      candidateScore,
      candidateTier,
      explanations,
    };
  }
}
