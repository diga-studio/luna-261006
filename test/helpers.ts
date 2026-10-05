import type { FrameRange, SegmentInput } from '../src/index.js';

/**
 * 独立的逐帧暴力参考实现：不依赖 src 内部逻辑，
 * 直接用 BigInt 分数计算每个成片帧的素材覆盖范围并两两比较。
 */

interface SourceSpan {
  readonly sourceId: string;
  readonly loNum: bigint;
  readonly loDen: bigint;
  readonly hiNum: bigint;
  readonly hiDen: bigint;
}

/** 某片段内第 i 帧（成片绝对帧号 frame）覆盖的素材范围。 */
function frameSourceSpan(
  seg: SegmentInput,
  segmentTimelineStart: number,
  frame: number,
): SourceSpan {
  const i = BigInt(frame - segmentTimelineStart);
  const duration = BigInt(seg.duration);
  const sourceStart = BigInt(seg.sourceStart);
  const sourceEnd = BigInt(seg.sourceEnd);
  const span = sourceEnd - sourceStart;
  const boundary = (k: bigint): readonly [bigint, bigint] =>
    seg.direction === 'forward'
      ? [sourceStart * duration + span * k, duration]
      : [sourceEnd * duration - span * k, duration];
  const [n0, d0] = boundary(i);
  const [n1, d1] = boundary(i + 1n);
  const loFirst = n0 * d1 <= n1 * d0;
  return {
    sourceId: seg.sourceId,
    loNum: loFirst ? n0 : n1,
    loDen: loFirst ? d0 : d1,
    hiNum: loFirst ? n1 : n0,
    hiDen: loFirst ? d1 : d0,
  };
}

export function totalFrames(segments: readonly SegmentInput[]): number {
  let total = 0;
  for (const seg of segments) {
    total += seg.duration;
  }
  return total;
}

export function versionFrameSpan(segments: readonly SegmentInput[], frame: number): SourceSpan {
  let cursor = 0;
  for (const seg of segments) {
    if (frame < cursor + seg.duration) {
      return frameSourceSpan(seg, cursor, frame);
    }
    cursor += seg.duration;
  }
  throw new Error(`frame out of range: ${frame}`);
}

/** 两个素材范围是否有正长度交集（仅端点相碰不算）。 */
function overlapsPositive(a: SourceSpan, b: SourceSpan): boolean {
  // max(a.lo, b.lo) < min(a.hi, b.hi)
  const loCmp = a.loNum * b.loDen - b.loNum * a.loDen;
  const hiCmp = a.hiNum * b.hiDen - b.hiNum * a.hiDen;
  const loNum = loCmp >= 0n ? a.loNum : b.loNum;
  const loDen = loCmp >= 0n ? a.loDen : b.loDen;
  const hiNum = hiCmp <= 0n ? a.hiNum : b.hiNum;
  const hiDen = hiCmp <= 0n ? a.hiDen : b.hiDen;
  return loNum * hiDen < hiNum * loDen;
}

export interface BruteAnnotation {
  readonly startFrame: number;
  readonly endFrame: number;
}

/** 暴力迁移一条批注：返回新版命中帧合并后的区间。 */
export function bruteForceMigrate(
  oldSegments: readonly SegmentInput[],
  newSegments: readonly SegmentInput[],
  annotation: BruteAnnotation,
): FrameRange[] {
  const start = annotation.startFrame;
  const end =
    annotation.endFrame === annotation.startFrame ? annotation.startFrame + 1 : annotation.endFrame;
  const oldSpans: SourceSpan[] = [];
  for (let frame = start; frame < end; frame++) {
    oldSpans.push(versionFrameSpan(oldSegments, frame));
  }
  const newTotal = totalFrames(newSegments);
  const hitFrames: number[] = [];
  for (let frame = 0; frame < newTotal; frame++) {
    const newSpan = versionFrameSpan(newSegments, frame);
    for (const oldSpan of oldSpans) {
      if (oldSpan.sourceId !== newSpan.sourceId) {
        continue;
      }
      if (overlapsPositive(oldSpan, newSpan)) {
        hitFrames.push(frame);
        break;
      }
    }
  }
  const ranges: FrameRange[] = [];
  for (const frame of hitFrames) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last.endFrame === frame) {
      (last as { endFrame: number }).endFrame = frame + 1;
    } else {
      ranges.push({ startFrame: frame, endFrame: frame + 1 });
    }
  }
  return ranges;
}

/** 确定性伪随机数生成器（mulberry32）。 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
