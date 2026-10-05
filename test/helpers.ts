import type { Annotation, ClipSegment, FrameInterval } from '../src/index.js';

interface Rat {
  num: bigint;
  den: bigint;
}

function ratLess(a: Rat, b: Rat): boolean {
  return a.num * b.den < b.num * a.den;
}

interface PlacedSegment {
  segment: ClipSegment;
  start: number;
}

function layout(segments: readonly ClipSegment[]): PlacedSegment[] {
  const placed: PlacedSegment[] = [];
  let cursor = 0;
  for (const segment of segments) {
    placed.push({ segment, start: cursor });
    cursor += segment.timelineLength;
  }
  return placed;
}

/** 成片帧 frame 在所属片段中覆盖的素材范围（左闭右开，精确有理数）。 */
export function frameSourceCoverage(
  placed: readonly PlacedSegment[],
  frame: number,
): { mediaId: string; lo: Rat; hi: Rat } {
  for (const ps of placed) {
    const seg = ps.segment;
    if (frame < ps.start || frame >= ps.start + seg.timelineLength) {
      continue;
    }
    const local = frame - ps.start;
    const length = seg.timelineLength;
    // 从素材起边界数的切片序号：倒放时帧序与切片序相反。
    const slice = seg.direction === 'forward' ? local : length - 1 - local;
    const s0 = BigInt(seg.sourceStartFrame);
    const span = BigInt(seg.sourceEndFrame - seg.sourceStartFrame);
    const len = BigInt(length);
    return {
      mediaId: seg.mediaId,
      lo: { num: s0 * len + BigInt(slice) * span, den: len },
      hi: { num: s0 * len + BigInt(slice + 1) * span, den: len },
    };
  }
  throw new Error(`frame ${frame} out of timeline`);
}

function merge(intervals: FrameInterval[]): FrameInterval[] {
  if (intervals.length === 0) {
    return [];
  }
  const sorted = [...intervals].sort((a, b) => a.startFrame - b.startFrame);
  const out: FrameInterval[] = [];
  let curStart = sorted[0].startFrame;
  let curEnd = sorted[0].endFrame;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i];
    if (iv.startFrame <= curEnd) {
      curEnd = Math.max(curEnd, iv.endFrame);
    } else {
      out.push({ startFrame: curStart, endFrame: curEnd });
      curStart = iv.startFrame;
      curEnd = iv.endFrame;
    }
  }
  out.push({ startFrame: curStart, endFrame: curEnd });
  return out;
}

/**
 * 独立逐帧暴力参考实现：对旧批注覆盖的每个成片帧、新版的每个成片帧，
 * 按“同一素材且覆盖范围有正长度交集”逐帧判定，再合并相邻区间。
 */
export function bruteForceMigrate(
  oldSegments: readonly ClipSegment[],
  newSegments: readonly ClipSegment[],
  annotation: Annotation,
): FrameInterval[] {
  const oldPlaced = layout(oldSegments);
  const newPlaced = layout(newSegments);
  const newTotal = newPlaced.reduce((acc, ps) => acc + ps.segment.timelineLength, 0);
  const start = annotation.startFrame;
  const end = annotation.endFrame === annotation.startFrame
    ? annotation.startFrame + 1
    : annotation.endFrame;
  const hits: FrameInterval[] = [];
  let runStart = -1;
  let prev = -1;
  for (let g = 0; g < newTotal; g++) {
    const covNew = frameSourceCoverage(newPlaced, g);
    let hit = false;
    for (let f = start; f < end; f++) {
      const covOld = frameSourceCoverage(oldPlaced, f);
      if (covOld.mediaId !== covNew.mediaId) {
        continue;
      }
      if (ratLess(covOld.lo, covNew.hi) && ratLess(covNew.lo, covOld.hi)) {
        hit = true;
        break;
      }
    }
    if (hit) {
      if (runStart < 0) {
        runStart = g;
      }
      prev = g;
    } else if (runStart >= 0) {
      hits.push({ startFrame: runStart, endFrame: prev + 1 });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    hits.push({ startFrame: runStart, endFrame: prev + 1 });
  }
  return merge(hits);
}
