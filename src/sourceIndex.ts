import type { PositionedSegment } from './timeline.js';
import type { Rational } from './rational.js';

/**
 * 单个素材的片段桶：按素材起边界排序，
 * 并用“最大素材止边界”线段树加速区间刺探查询。
 */
interface MediaBucket {
  /** 按 sourceStartFrame 升序。 */
  readonly segs: PositionedSegment[];
  readonly starts: number[];
  /** 线段树，叶子在 [base, base + n)，存子树内最大 sourceEndFrame。 */
  readonly tree: Float64Array;
  readonly base: number;
}

function buildBucket(segs: PositionedSegment[]): MediaBucket {
  segs.sort((a, b) => a.segment.sourceStartFrame - b.segment.sourceStartFrame);
  const n = segs.length;
  const starts = new Array<number>(n);
  let base = 1;
  while (base < n) {
    base <<= 1;
  }
  const tree = new Float64Array(2 * base);
  for (let i = 0; i < n; i++) {
    starts[i] = segs[i].segment.sourceStartFrame;
    tree[base + i] = segs[i].segment.sourceEndFrame;
  }
  for (let node = base - 1; node >= 1; node--) {
    const left = tree[2 * node];
    const right = tree[2 * node + 1];
    tree[node] = left >= right ? left : right;
  }
  return { segs, starts, tree, base };
}

/**
 * 新版素材覆盖索引：按原素材标识分组。
 * 查询指定素材上素材覆盖范围与 (lo, hi) 有正长度交集的全部片段。
 */
export class SourceIndex {
  private readonly buckets = new Map<string, MediaBucket>();

  constructor(segments: readonly PositionedSegment[]) {
    const groups = new Map<string, PositionedSegment[]>();
    for (const ps of segments) {
      const list = groups.get(ps.segment.mediaId);
      if (list === undefined) {
        groups.set(ps.segment.mediaId, [ps]);
      } else {
        list.push(ps);
      }
    }
    for (const [mediaId, list] of groups) {
      this.buckets.set(mediaId, buildBucket(list));
    }
  }

  /**
   * 返回指定素材上、素材覆盖范围与 (lo, hi) 有正长度交集的全部片段。
   * 仅端点相碰不算命中。
   */
  query(mediaId: string, lo: Rational, hi: Rational): PositionedSegment[] {
    const bucket = this.buckets.get(mediaId);
    if (bucket === undefined) {
      return [];
    }
    const { segs, starts, tree, base } = bucket;
    const n = segs.length;
    // m = 第一个 sourceStartFrame >= hi 的下标；候选下标为 [0, m)。
    const hiNum = hi.num;
    const hiDen = hi.den;
    let loIdx = 0;
    let hiIdx = n;
    while (loIdx < hiIdx) {
      const mid = (loIdx + hiIdx) >> 1;
      if (BigInt(starts[mid]) * hiDen < hiNum) {
        loIdx = mid + 1;
      } else {
        hiIdx = mid;
      }
    }
    const m = loIdx;
    const result: PositionedSegment[] = [];
    if (m === 0) {
      return result;
    }
    // 在线段树上收集 [0, m) 内 sourceEndFrame > lo 的叶子。
    const loNum = lo.num;
    const loDen = lo.den;
    const stack: number[] = [1];
    const stackLo: number[] = [0];
    const stackHi: number[] = [base];
    while (stack.length > 0) {
      const node = stack.pop() as number;
      const nodeLo = stackLo.pop() as number;
      const nodeHi = stackHi.pop() as number;
      if (nodeLo >= m) {
        continue;
      }
      // 子树最大 sourceEndFrame <= lo 时整棵子树剪枝（端点相碰不算命中）。
      if (BigInt(tree[node]) * loDen <= loNum) {
        continue;
      }
      if (node >= base) {
        const idx = node - base;
        if (idx < n) {
          result.push(segs[idx]);
        }
        continue;
      }
      const mid = (nodeLo + nodeHi) >> 1;
      stack.push(2 * node, 2 * node + 1);
      stackLo.push(nodeLo, mid);
      stackHi.push(mid, nodeHi);
    }
    return result;
  }
}
