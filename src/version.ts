import type { AnnotationInput, SegmentInput } from './types.js';

/** 归一化后的剪辑段：附带成片时间轴偏移。 */
export interface NormalizedSegment {
  readonly sourceId: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly duration: number;
  readonly forward: boolean;
  /** 该段在成片时间轴上的起始帧（含）。 */
  readonly timelineStart: number;
}

function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${what} must be a safe integer, got ${value}`);
  }
}

/** 一个剪辑版本：片段依次拼接，从第 0 帧开始无空隙。 */
export class Version {
  readonly id: string;
  readonly segments: readonly NormalizedSegment[];
  /** 成片总帧数。 */
  readonly totalFrames: number;

  constructor(id: string, segments: readonly SegmentInput[]) {
    this.id = id;
    const normalized: NormalizedSegment[] = new Array(segments.length);
    let cursor = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (typeof seg.sourceId !== 'string' || seg.sourceId.length === 0) {
        throw new TypeError(`segment ${i}: sourceId must be a non-empty string`);
      }
      assertSafeInteger(seg.sourceStart, `segment ${i} sourceStart`);
      assertSafeInteger(seg.sourceEnd, `segment ${i} sourceEnd`);
      assertSafeInteger(seg.duration, `segment ${i} duration`);
      if (seg.sourceEnd <= seg.sourceStart) {
        throw new RangeError(
          `segment ${i}: sourceEnd (${seg.sourceEnd}) must be greater than sourceStart (${seg.sourceStart})`,
        );
      }
      if (seg.duration <= 0) {
        throw new RangeError(`segment ${i}: duration must be a positive integer, got ${seg.duration}`);
      }
      if (seg.direction !== 'forward' && seg.direction !== 'reverse') {
        throw new RangeError(`segment ${i}: direction must be 'forward' or 'reverse'`);
      }
      normalized[i] = {
        sourceId: seg.sourceId,
        sourceStart: seg.sourceStart,
        sourceEnd: seg.sourceEnd,
        duration: seg.duration,
        forward: seg.direction === 'forward',
        timelineStart: cursor,
      };
      cursor += seg.duration;
      assertSafeInteger(cursor, `version ${id} total frames`);
    }
    this.segments = normalized;
    this.totalFrames = cursor;
  }

  /** 找到覆盖成片帧 frame 的段下标；frame 越界时返回 -1。 */
  segmentIndexAt(frame: number): number {
    if (frame < 0 || frame >= this.totalFrames) {
      return -1;
    }
    const segs = this.segments;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid]!.timelineStart <= frame) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }
}

/** 归一化后的批注：左闭右开，单点已展开为覆盖一个完整帧。 */
export interface NormalizedAnnotation {
  readonly id: string;
  readonly startFrame: number;
  readonly endFrame: number;
}

export function normalizeAnnotation(
  input: AnnotationInput,
  totalFrames: number,
): NormalizedAnnotation {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    throw new TypeError('annotation id must be a non-empty string');
  }
  assertSafeInteger(input.startFrame, `annotation ${input.id} startFrame`);
  assertSafeInteger(input.endFrame, `annotation ${input.id} endFrame`);
  if (input.startFrame < 0) {
    throw new RangeError(`annotation ${input.id}: startFrame must be >= 0, got ${input.startFrame}`);
  }
  if (input.endFrame < input.startFrame) {
    throw new RangeError(
      `annotation ${input.id}: endFrame (${input.endFrame}) must be >= startFrame (${input.startFrame})`,
    );
  }
  // 单点批注按覆盖一个完整成片帧处理。
  const endFrame = input.endFrame === input.startFrame ? input.startFrame + 1 : input.endFrame;
  if (endFrame > totalFrames) {
    throw new RangeError(
      `annotation ${input.id}: endFrame (${endFrame}) exceeds version total frames (${totalFrames})`,
    );
  }
  return { id: input.id, startFrame: input.startFrame, endFrame };
}
