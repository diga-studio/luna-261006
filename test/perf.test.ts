import { describe, expect, it } from 'vitest';
import { MigrationPreviewer } from '../src/index.js';
import type { Annotation, ClipSegment } from '../src/index.js';

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MEDIA_COUNT = 5;
const MEDIA_SPAN = 1_500_000;
const SEGMENT_COUNT = 100_000;
const ANNOTATION_COUNT = 50_000;

/**
 * 构造一个版本：大量同源不相交短段 + 少量覆盖大范围的长段混用。
 * 短段含正放/倒放与非整数倍速。
 */
function buildVersion(rng: () => number): ClipSegment[] {
  const segments: ClipSegment[] = [];
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const mediaId = `media-${i % MEDIA_COUNT}`;
    if (i % 1000 === 0) {
      // 长段：覆盖 100k 素材帧，二倍速。
      const start = Math.floor(rng() * (MEDIA_SPAN - 100_000));
      segments.push({
        mediaId,
        sourceStartFrame: start,
        sourceEndFrame: start + 100_000,
        timelineLength: 50_000,
        direction: rng() < 0.5 ? 'forward' : 'reverse',
      });
    } else {
      const sourceLen = 10 + Math.floor(rng() * 20);
      const timelineLength = 10 + Math.floor(rng() * 20);
      const start = Math.floor(rng() * (MEDIA_SPAN - sourceLen));
      segments.push({
        mediaId,
        sourceStartFrame: start,
        sourceEndFrame: start + sourceLen,
        timelineLength,
        direction: rng() < 0.5 ? 'forward' : 'reverse',
      });
    }
  }
  return segments;
}

function buildAnnotations(rng: () => number, oldSegments: ClipSegment[]): Annotation[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const seg of oldSegments) {
    starts.push(cursor);
    cursor += seg.timelineLength;
  }
  const annotations: Annotation[] = [];
  for (let i = 0; i < ANNOTATION_COUNT; i++) {
    // 每条批注最多跨 4 个短段：起点随机，长度限制在约 4 个短段内。
    const segIndex = 1 + Math.floor(rng() * (SEGMENT_COUNT - 6));
    const start = starts[segIndex] + Math.floor(rng() * oldSegments[segIndex].timelineLength);
    const maxEnd = starts[Math.min(segIndex + 4, SEGMENT_COUNT - 1)];
    const end = Math.min(maxEnd, start + 1 + Math.floor(rng() * 60));
    annotations.push({ id: `ann-${i}`, startFrame: start, endFrame: Math.max(end, start + 1) });
  }
  return annotations;
}

describe('性能与内存（10 万段/版，5 万条批注）', () => {
  it('全量迁移预览在 20 秒内完成，额外堆内存 ≤ 256 MiB', { timeout: 120_000 }, () => {
    const rng = makeRng(42);
    const oldSegments = buildVersion(rng);
    const newSegments = buildVersion(rng);
    const annotations = buildAnnotations(rng, oldSegments);

    globalThis.gc?.();
    const memBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();

    const previewer = new MigrationPreviewer();
    previewer.registerVersion('old', oldSegments);
    previewer.registerVersion('new', newSegments);
    previewer.registerAnnotations('old', annotations);
    const results = previewer.createPreview('old', 'new');

    const elapsedMs = performance.now() - t0;
    globalThis.gc?.();
    const memAfter = process.memoryUsage().heapUsed;

    let intervalCount = 0;
    let maxIntervals = 0;
    for (const result of results) {
      intervalCount += result.intervals.length;
      maxIntervals = Math.max(maxIntervals, result.intervals.length);
    }
    const memDeltaMiB = (memAfter - memBefore) / 1024 / 1024;
    console.log(
      `[perf] ${elapsedMs.toFixed(0)}ms, heap +${memDeltaMiB.toFixed(1)} MiB, ` +
        `${results.length} results, ${intervalCount} intervals, max ${maxIntervals}/annotation`,
    );

    expect(results).toHaveLength(ANNOTATION_COUNT);
    expect(intervalCount).toBeLessThanOrEqual(500_000);
    expect(elapsedMs).toBeLessThan(20_000);
    expect(memDeltaMiB).toBeLessThanOrEqual(256);
  });
});
