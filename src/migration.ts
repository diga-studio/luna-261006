import { SourceIntervalIndex } from './interval-index.js';
import type { Rational } from './rational.js';
import type { AnnotationMigration, FrameRange } from './types.js';
import type { NormalizedAnnotation, NormalizedSegment, Version } from './version.js';

/** b > 0 时的向下取整除法。 */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/** b > 0 时的向上取整除法。 */
function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b);
}

/** 批注在旧版单个片段上覆盖的素材范围（有理数，qs < qe）。 */
interface SourceQuery {
  readonly sourceId: string;
  readonly qs: Rational;
  readonly qe: Rational;
}

/**
 * 成片时间轴边界 t（整数帧边界）映射到素材坐标（有理数）。
 * 正放从 sourceStart 走向 sourceEnd，倒放相反。
 */
function mapTimelineToSource(seg: NormalizedSegment, t: number): Rational {
  const offset = BigInt(t - seg.timelineStart);
  const duration = BigInt(seg.duration);
  const span = BigInt(seg.sourceEnd - seg.sourceStart);
  if (seg.forward) {
    return {
      num: BigInt(seg.sourceStart) * duration + span * offset,
      den: duration,
    };
  }
  return {
    num: BigInt(seg.sourceEnd) * duration - span * offset,
    den: duration,
  };
}

/** 计算旧批注在旧版各片段上覆盖的素材范围。 */
function annotationSourceQueries(version: Version, ann: NormalizedAnnotation): SourceQuery[] {
  const segs = version.segments;
  const queries: SourceQuery[] = [];
  const first = version.segmentIndexAt(ann.startFrame);
  for (let i = first; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg.timelineStart >= ann.endFrame) {
      break;
    }
    const t0 = Math.max(ann.startFrame, seg.timelineStart);
    const t1 = Math.min(ann.endFrame, seg.timelineStart + seg.duration);
    const s0 = mapTimelineToSource(seg, t0);
    const s1 = mapTimelineToSource(seg, t1);
    if (seg.forward) {
      queries.push({ sourceId: seg.sourceId, qs: s0, qe: s1 });
    } else {
      queries.push({ sourceId: seg.sourceId, qs: s1, qe: s0 });
    }
  }
  return queries;
}

/**
 * 新版一个片段中，素材覆盖范围与 [qs, qe) 有正长度交集的成片帧下标
 * （段内闭区间 [f0, f1]）。无命中返回 null。
 *
 * 段内第 i 帧覆盖素材边界 b(i) 到 b(i+1)：
 * 正放 b(i) = S0 + span*i/D，倒放 b(i) = S1 - span*i/D。
 * 命中条件为严格不等式，端点相碰不算命中，全部用 BigInt 精确求解。
 */
function frameRangeForSegment(
  seg: NormalizedSegment,
  qs: Rational,
  qe: Rational,
): readonly [number, number] | null {
  const sourceStart = BigInt(seg.sourceStart);
  const sourceEnd = BigInt(seg.sourceEnd);
  const duration = BigInt(seg.duration);
  const span = sourceEnd - sourceStart;
  let f0: bigint;
  let f1: bigint;
  if (seg.forward) {
    // b(i+1) > qs  ⟺  i >= floor((qs.num*D - S0*D*qs.den) / (span*qs.den))
    f0 = floorDiv(qs.num * duration - sourceStart * duration * qs.den, span * qs.den);
    // b(i) < qe  ⟺  i <= ceil((qe.num*D - S0*D*qe.den) / (span*qe.den)) - 1
    f1 = ceilDiv(qe.num * duration - sourceStart * duration * qe.den, span * qe.den) - 1n;
  } else {
    // b(i+1) < qe  ⟺  i >= floor((S1*D*qe.den - qe.num*D) / (span*qe.den))
    f0 = floorDiv(sourceEnd * duration * qe.den - qe.num * duration, span * qe.den);
    // b(i) > qs  ⟺  i <= ceil((S1*D*qs.den - qs.num*D) / (span*qs.den)) - 1
    f1 = ceilDiv(sourceEnd * duration * qs.den - qs.num * duration, span * qs.den) - 1n;
  }
  if (f0 < 0n) {
    f0 = 0n;
  }
  const last = duration - 1n;
  if (f1 > last) {
    f1 = last;
  }
  if (f0 > f1) {
    return null;
  }
  return [Number(f0), Number(f1)];
}

/** 排序后合并重叠或相邻（首尾相接）的区间。 */
function mergeIntervals(intervals: FrameRange[]): FrameRange[] {
  if (intervals.length <= 1) {
    return intervals;
  }
  intervals.sort((a, b) => a.startFrame - b.startFrame);
  const merged: FrameRange[] = [];
  let curStart = intervals[0]!.startFrame;
  let curEnd = intervals[0]!.endFrame;
  for (let i = 1; i < intervals.length; i++) {
    const iv = intervals[i]!;
    if (iv.startFrame <= curEnd) {
      if (iv.endFrame > curEnd) {
        curEnd = iv.endFrame;
      }
    } else {
      merged.push({ startFrame: curStart, endFrame: curEnd });
      curStart = iv.startFrame;
      curEnd = iv.endFrame;
    }
  }
  merged.push({ startFrame: curStart, endFrame: curEnd });
  return merged;
}

/**
 * 核心迁移：把旧版的一批批注映射到新版成片帧区间。
 * 每条旧批注都有独立结果（含空结果），结果按新版位置排序，
 * 重叠或相邻区间合并，不同批注之间不合并。
 */
export function migrateAnnotations(
  fromVersion: Version,
  toVersion: Version,
  annotations: readonly NormalizedAnnotation[],
): AnnotationMigration[] {
  // 新版段按素材标识建区间索引，重复引用会全部登记。
  const index = new SourceIntervalIndex<number>();
  const toSegs = toVersion.segments;
  for (let j = 0; j < toSegs.length; j++) {
    const seg = toSegs[j]!;
    index.add(seg.sourceId, { lo: seg.sourceStart, hi: seg.sourceEnd, payload: j });
  }
  index.finish();

  const results: AnnotationMigration[] = new Array(annotations.length);
  const hits: number[] = [];
  for (let a = 0; a < annotations.length; a++) {
    const ann = annotations[a]!;
    const intervals: FrameRange[] = [];
    for (const query of annotationSourceQueries(fromVersion, ann)) {
      // 整数界转换：lo < qHiInt ⟺ lo < qe，hi > qLoInt ⟺ hi > qs（lo/hi 为整数）。
      const qLo = Number(floorDiv(query.qs.num, query.qs.den));
      const qHi = Number(ceilDiv(query.qe.num, query.qe.den));
      hits.length = 0;
      index.query(query.sourceId, qLo, qHi, hits);
      for (const j of hits) {
        const seg = toSegs[j]!;
        const range = frameRangeForSegment(seg, query.qs, query.qe);
        if (range !== null) {
          intervals.push({
            startFrame: seg.timelineStart + range[0],
            endFrame: seg.timelineStart + range[1] + 1,
          });
        }
      }
    }
    results[a] = { annotationId: ann.id, ranges: mergeIntervals(intervals) };
  }
  return results;
}
