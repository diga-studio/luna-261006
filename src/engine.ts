import { findExplanations } from './explain';
import {
  compileRule,
  DEFAULT_BASE_RULE,
  maskFromIndicators,
  resolveCandidate,
  scoreForMask,
  tierForScore,
  validateRuleSet,
} from './rules';
import type { CompiledRule } from './rules';
import type {
  CandidateRule,
  ExplanationCount,
  MigrationDirection,
  ParamKey,
  PreviewResult,
  RuleSet,
  StudentInput,
  StudentPreview,
  Tier,
} from './types';
import { TIERS } from './types';

const BUCKET_COUNT = 64;

function emptyMigration(): Record<Tier, Record<Tier, number>> {
  const matrix = {} as Record<Tier, Record<Tier, number>>;
  for (const from of TIERS) {
    matrix[from] = { low: 0, mid: 0, high: 0 };
  }
  return matrix;
}

/**
 * In-memory preview engine. Students are loaded once as a read-only snapshot;
 * every preview is computed independently from the base rule.
 *
 * Only 2^6 = 64 distinct indicator combinations exist, so students are
 * aggregated into 64 buckets at load time; a full preview touches buckets,
 * not individual students.
 */
export class RetainEdgePreview {
  private readonly base: RuleSet;
  private readonly baseCompiled: CompiledRule;
  private readonly masks: Uint8Array;
  private readonly ids: string[];
  private readonly indexById: Map<string, number>;
  private readonly bucketCounts: Uint32Array;
  private readonly baseScoreByBucket: Uint8Array;
  private readonly baseTierByBucket: Tier[];

  constructor(students: Iterable<StudentInput>, baseRule?: RuleSet) {
    const base: RuleSet = baseRule
      ? {
          weights: { ...baseRule.weights },
          midThreshold: baseRule.midThreshold,
          highThreshold: baseRule.highThreshold,
        }
      : {
          weights: { ...DEFAULT_BASE_RULE.weights },
          midThreshold: DEFAULT_BASE_RULE.midThreshold,
          highThreshold: DEFAULT_BASE_RULE.highThreshold,
        };
    validateRuleSet(base);
    this.base = base;
    this.baseCompiled = compileRule(base);

    const masks: number[] = [];
    const ids: string[] = [];
    this.indexById = new Map();
    this.bucketCounts = new Uint32Array(BUCKET_COUNT);
    for (const student of students) {
      if (student === null || typeof student !== 'object') {
        throw new TypeError('student must be an object');
      }
      const { id, indicators } = student;
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError(`student id must be a non-empty string, got ${String(id)}`);
      }
      if (this.indexById.has(id)) {
        throw new Error(`duplicate student id: ${id}`);
      }
      if (indicators === null || typeof indicators !== 'object') {
        throw new TypeError(`student ${id}: indicators must be an object`);
      }
      const mask = maskFromIndicators(indicators);
      this.indexById.set(id, ids.length);
      ids.push(id);
      masks.push(mask);
      this.bucketCounts[mask]!++;
    }
    this.ids = ids;
    this.masks = Uint8Array.from(masks);

    this.baseScoreByBucket = new Uint8Array(BUCKET_COUNT);
    this.baseTierByBucket = new Array<Tier>(BUCKET_COUNT);
    for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
      const score = scoreForMask(bucket, this.baseCompiled);
      this.baseScoreByBucket[bucket] = score;
      this.baseTierByBucket[bucket] = tierForScore(
        score,
        this.baseCompiled.mid,
        this.baseCompiled.high,
      );
    }
  }

  get size(): number {
    return this.ids.length;
  }

  getBaseRule(): RuleSet {
    return {
      weights: { ...this.base.weights },
      midThreshold: this.base.midThreshold,
      highThreshold: this.base.highThreshold,
    };
  }

  /** Full preview: 3x3 migration matrix plus explanation counts. */
  preview(candidate: CandidateRule): PreviewResult {
    const resolved = resolveCandidate(this.base, candidate);
    const compiled = compileRule(resolved);

    const migration = emptyMigration();
    // direction -> param-set key -> aggregated entry
    const byDirection = new Map<string, Map<string, ExplanationCount>>();

    for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
      const count = this.bucketCounts[bucket]!;
      if (count === 0) continue;
      const candidateScore = scoreForMask(bucket, compiled);
      const candidateTier = tierForScore(candidateScore, compiled.mid, compiled.high);
      const baseTier = this.baseTierByBucket[bucket]!;
      migration[baseTier][candidateTier] += count;
      if (baseTier === candidateTier) continue;

      const explanations = findExplanations(bucket, this.baseCompiled, compiled, candidateTier);
      const direction: MigrationDirection = `${baseTier}->${candidateTier}`;
      let directionMap = byDirection.get(direction);
      if (!directionMap) {
        directionMap = new Map();
        byDirection.set(direction, directionMap);
      }
      for (const params of explanations) {
        const key = params.join('|');
        const entry = directionMap.get(key);
        if (entry) entry.count += count;
        else directionMap.set(key, { params, count });
      }
    }

    const explanations: PreviewResult['explanations'] = {};
    for (const [direction, entries] of byDirection) {
      const list = [...entries.values()].sort(
        (a, b) =>
          a.params.length - b.params.length ||
          a.params.join('|').localeCompare(b.params.join('|')),
      );
      explanations[direction as MigrationDirection] = list;
    }

    return {
      resolvedRule: resolved,
      totalStudents: this.ids.length,
      migration,
      explanations,
    };
  }

  /** Per-student before/after score, tier and explanations. */
  previewStudent(id: string, candidate: CandidateRule): StudentPreview {
    const index = this.indexById.get(id);
    if (index === undefined) {
      throw new Error(`unknown student id: ${id}`);
    }
    const mask = this.masks[index]!;
    const resolved = resolveCandidate(this.base, candidate);
    const compiled = compileRule(resolved);

    const baseScore = this.baseScoreByBucket[mask]!;
    const baseTier = this.baseTierByBucket[mask]!;
    const candidateScore = scoreForMask(mask, compiled);
    const candidateTier = tierForScore(candidateScore, compiled.mid, compiled.high);
    const changed = baseTier !== candidateTier;
    const explanations: ParamKey[][] = changed
      ? findExplanations(mask, this.baseCompiled, compiled, candidateTier)
      : [];
    return { id, baseScore, baseTier, candidateScore, candidateTier, changed, explanations };
  }
}
