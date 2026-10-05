import type { Annotation, FrameInterval, MigrationResult } from './types.js';
import type { TimelineIndex, PositionedSegment } from './timeline.js';
import type { SourceIndex } from './sourceIndex.js';
import type { Rational } from './rational.js';
import { compareInt, floorScaledDelta, rationalFromInt } from './rational.js';

/**
 * 把一批旧版批注迁移到新版时间线。
 * 每条旧批注都有独立结果（可能为空）；结果区间按新版位置排序并合并相邻/重叠区间。
 */
export function migrateAnnotations(
  oldTimeline: TimelineIndex,
  newSource: SourceIndex,
  annotations: readonly Annotation[],
): MigrationResult[] {
  const results = new Array<MigrationResult>(annotations.length);
  for (let i = 0; i < annotations.length; i++) {
    results[i] = migrateOne(oldTimeline, newSource, annotations[i]);
  }
  return results;
}

/** 单点批注按覆盖一个完整成片帧处理。 */
export function normalizeAnnotationRange(annotation: Annotation): [number, number] {
  const { startFrame, endFrame } = annotation;
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)) {
    throw new Error(`annotation ${annotation.id}: frames must be safe integers`);
  }
  if (startFrame < 0) {
    throw new Error(`annotation ${annotation.id}: startFrame must be non-negative`);
  }
  if (endFrame < startFrame) {
    throw new Error(`annotation ${annotation.id}: endFrame must be >= startFrame`);
  }
  return endFrame === startFrame ? [startFrame, startFrame + 1] : [startFrame, endFrame];
}

function migrateOne(
  oldTimeline: TimelineIndex,
  newSource: SourceIndex,
  annotation: Annotation,
): MigrationResult {
  const [start, end] = normalizeAnnotationRange(annotation);
  const intervals: FrameInterval[] = [];
  for (const ps of oldTimeline.overlapping(start, end)) {
    const seg = ps.segment;
    const length = seg.timelineLength;
    // 批注在该片段内覆盖的成片帧 [f0, f1)。
    const f0 = Math.max(start, ps.timelineStart) - ps.timelineStart;
    const f1 = Math.min(end, ps.timelineStart + length) - ps.timelineStart;
    // 换算为从素材起边界数的切片序号 [s0, s1)：倒放时帧序与切片序相反。
    const s0 = seg.direction === 'forward' ? f0 : length - f1;
    const s1 = seg.direction === 'forward' ? f1 : length - f0;
    // 素材覆盖范围 [S0 + s0*D/L, S0 + s1*D/L)，以精确有理数表示。
    const sourceStart = BigInt(seg.sourceStartFrame);
    const span = BigInt(seg.sourceEndFrame - seg.sourceStartFrame);
    const len = BigInt(length);
    const lo: Rational = { num: sourceStart * len + BigInt(s0) * span, den: len };
    const hi: Rational = { num: sourceStart * len + BigInt(s1) * span, den: len };
    for (const hit of newSource.query(seg.mediaId, lo, hi)) {
      intervals.push(hitInterval(hit, lo, hi));
    }
  }
  return { annotationId: annotation.id, intervals: mergeIntervals(intervals) };
}

/**
 * 计算新版某片段上被素材范围 (lo, hi) 命中的成片帧区间（左闭右开）。
 * 切片 j 覆盖素材范围 [U0 + j*D/L, U0 + (j+1)*D/L)，
 * 命中当且仅当与 (max(lo,U0), min(hi,U1)) 有正长度交集。
 */
function hitInterval(ps: PositionedSegment, lo: Rational, hi: Rational): FrameInterval {
  const seg = ps.segment;
  const length = seg.timelineLength;
  const len = BigInt(length);
  const u0 = BigInt(seg.sourceStartFrame);
  const span = BigInt(seg.sourceEndFrame - seg.sourceStartFrame);
  const u1 = u0 + span;
  // 把 (lo, hi) 裁剪到该片段的素材范围 [U0, U1)。
  const clampedLo = compareInt(lo, u0) < 0 ? rationalFromInt(u0) : lo;
  const clampedHi = compareInt(hi, u1) > 0 ? rationalFromInt(u1) : hi;
  // jMin = floor((clampedLo - U0) * L / D)
  const jMin = floorScaledDelta(clampedLo, u0, len, span);
  // jMax = ceil((clampedHi - U0) * L / D) - 1 = (num - 1) / den（被除数恒为正）
  const hiNum = (clampedHi.num - u0 * clampedHi.den) * len;
  const hiDen = clampedHi.den * span;
  const jMax = (hiNum - 1n) / hiDen;
  const lastSlice = len - 1n;
  const sliceStart = jMin > lastSlice ? lastSlice : jMin;
  const sliceEnd = jMax > lastSlice ? lastSlice : jMax;
  // 切片序号换算回成片帧号：倒放时帧 f 对应切片 L-1-f。
  const s0 = Number(sliceStart);
  const s1 = Number(sliceEnd);
  const frameStart = seg.direction === 'forward' ? s0 : length - 1 - s1;
  const frameEnd = seg.direction === 'forward' ? s1 : length - 1 - s0;
  return {
    startFrame: ps.timelineStart + frameStart,
    endFrame: ps.timelineStart + frameEnd + 1,
  };
}

/** 按起点排序并合并重叠或相邻的左闭右开区间。 */
function mergeIntervals(intervals: FrameInterval[]): FrameInterval[] {
  if (intervals.length <= 1) {
    return intervals;
  }
  const sorted = [...intervals].sort((a, b) => a.startFrame - b.startFrame);
  const merged: FrameInterval[] = [];
  let curStart = sorted[0].startFrame;
  let curEnd = sorted[0].endFrame;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i];
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
