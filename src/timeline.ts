import type { ClipSegment } from './types.js';

/** 带成片时间线起点的片段。 */
export interface PositionedSegment {
  readonly segment: ClipSegment;
  /** 片段在成片时间线上的起始帧（含）。 */
  readonly timelineStart: number;
}

function validateSegment(segment: ClipSegment, index: number): void {
  const where = `segment[${index}]`;
  if (typeof segment.mediaId !== 'string' || segment.mediaId.length === 0) {
    throw new Error(`${where}: mediaId must be a non-empty string`);
  }
  if (!Number.isSafeInteger(segment.sourceStartFrame) || segment.sourceStartFrame < 0) {
    throw new Error(`${where}: sourceStartFrame must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(segment.sourceEndFrame)) {
    throw new Error(`${where}: sourceEndFrame must be a safe integer`);
  }
  if (segment.sourceEndFrame <= segment.sourceStartFrame) {
    throw new Error(`${where}: sourceEndFrame must be greater than sourceStartFrame`);
  }
  if (!Number.isSafeInteger(segment.timelineLength) || segment.timelineLength <= 0) {
    throw new Error(`${where}: timelineLength must be a positive safe integer`);
  }
  if (segment.direction !== 'forward' && segment.direction !== 'reverse') {
    throw new Error(`${where}: direction must be 'forward' or 'reverse'`);
  }
}

/**
 * 一个剪辑版本的时间线索引：片段依次拼接、从第 0 帧开始、无空隙。
 * 支持按帧区间二分查找重叠片段。
 */
export class TimelineIndex {
  private readonly positioned: PositionedSegment[];
  private readonly starts: number[];
  private readonly total: number;

  constructor(segments: readonly ClipSegment[]) {
    const positioned = new Array<PositionedSegment>(segments.length);
    const starts = new Array<number>(segments.length);
    let cursor = 0;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      validateSegment(segment, i);
      positioned[i] = { segment, timelineStart: cursor };
      starts[i] = cursor;
      cursor += segment.timelineLength;
      if (!Number.isSafeInteger(cursor)) {
        throw new Error('timeline: total frame count exceeds safe integer range');
      }
    }
    this.positioned = positioned;
    this.starts = starts;
    this.total = cursor;
  }

  /** 成片总帧数。 */
  get totalFrames(): number {
    return this.total;
  }

  get segments(): readonly PositionedSegment[] {
    return this.positioned;
  }

  /** 返回与左闭右开区间 [startFrame, endFrame) 有正长度交集的全部片段（按时间线顺序）。 */
  overlapping(startFrame: number, endFrame: number): PositionedSegment[] {
    const result: PositionedSegment[] = [];
    if (endFrame <= startFrame || this.positioned.length === 0) {
      return result;
    }
    // 二分查找最后一个 timelineStart <= startFrame 的片段。
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= startFrame) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    for (let i = lo; i < this.positioned.length; i++) {
      const ps = this.positioned[i];
      if (ps.timelineStart >= endFrame) {
        break;
      }
      result.push(ps);
    }
    return result;
  }
}
