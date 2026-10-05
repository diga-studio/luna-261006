import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MigrationRegistry,
  type AnnotationInput,
  type SegmentInput,
} from '../src/index.js';

/**
 * 规模验证：新版 10 万段（大量同源不相交短段 + 少量覆盖长段），
 * 旧版 2.5 万段、5 万条批注，每条批注跨旧版 4 段、命中新版不超过 8 段，
 * 结果总区间数不超过 50 万。要求全量迁移 < 20s，额外内存 <= 256 MiB。
 */

const NUM_SOURCES = 200;
const SOURCE_LENGTH = 5000;
const SHORTS_PER_SOURCE = 497; // 每段 10 素材帧、5 成片帧
const SHORT_DURATION = 5;
const LONGS_PER_SOURCE = 3;
const GROUPS = 6250; // 旧版每组 4 段
const OLD_SEG_DURATION = 10;
const ANNOTATIONS_PER_GROUP = 8;

function buildNewVersion(): SegmentInput[] {
  const segments: SegmentInput[] = [];
  for (let s = 0; s < NUM_SOURCES; s++) {
    const sourceId = `S${s}`;
    for (let i = 0; i < SHORTS_PER_SOURCE; i++) {
      segments.push({
        sourceId,
        sourceStart: i * 10,
        sourceEnd: i * 10 + 10,
        duration: SHORT_DURATION,
        direction: i % 2 === 0 ? 'forward' : 'reverse',
      });
    }
    segments.push(
      { sourceId, sourceStart: 0, sourceEnd: SOURCE_LENGTH, duration: 1000, direction: 'forward' },
      { sourceId, sourceStart: 0, sourceEnd: SOURCE_LENGTH, duration: 500, direction: 'reverse' },
      { sourceId, sourceStart: 0, sourceEnd: SOURCE_LENGTH, duration: 800, direction: 'forward' },
    );
  }
  return segments;
}

function buildOldVersion(): SegmentInput[] {
  const segments: SegmentInput[] = [];
  for (let g = 0; g < GROUPS; g++) {
    const sourceId = `S${g % NUM_SOURCES}`;
    const base = (g * 131) % 4900;
    for (let j = 0; j < 4; j++) {
      segments.push({
        sourceId,
        sourceStart: base + j * 10,
        sourceEnd: base + j * 10 + 10,
        duration: OLD_SEG_DURATION,
        direction: j % 2 === 0 ? 'forward' : 'reverse',
      });
    }
  }
  return segments;
}

function buildAnnotations(): AnnotationInput[] {
  const annotations: AnnotationInput[] = [];
  for (let g = 0; g < GROUPS; g++) {
    for (let k = 0; k < ANNOTATIONS_PER_GROUP; k++) {
      annotations.push({
        id: `ann-${g}-${k}`,
        startFrame: g * 4 * OLD_SEG_DURATION,
        endFrame: (g + 1) * 4 * OLD_SEG_DURATION,
      });
    }
  }
  return annotations;
}

test('规模与性能：10万段/5万批注全量迁移 < 20s，额外内存 <= 256MiB', () => {
  const newSegments = buildNewVersion();
  const oldSegments = buildOldVersion();
  const annotations = buildAnnotations();
  assert.equal(newSegments.length, NUM_SOURCES * (SHORTS_PER_SOURCE + LONGS_PER_SOURCE));
  assert.equal(newSegments.length, 100_000);
  assert.equal(annotations.length, 50_000);

  const registry = new MigrationRegistry();
  registry.registerVersion('old', oldSegments);
  registry.registerVersion('new', newSegments);
  registry.registerAnnotations('old', annotations);

  global.gc!();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const preview = registry.migrate('old', 'new');
  const elapsedMs = performance.now() - started;
  const heapAfterMigrate = process.memoryUsage().heapUsed;
  global.gc!();
  const heapRetained = process.memoryUsage().heapUsed;

  // 结果完整性：每条批注都有独立结果。
  assert.equal(preview.results.length, annotations.length);

  let totalRanges = 0;
  let maxRangesPerAnnotation = 0;
  for (const result of preview.results) {
    totalRanges += result.ranges.length;
    if (result.ranges.length > maxRangesPerAnnotation) {
      maxRangesPerAnnotation = result.ranges.length;
    }
    // 结果按新版位置排序且不相交（合并后相邻也已合并）。
    for (let i = 1; i < result.ranges.length; i++) {
      assert.ok(result.ranges[i]!.startFrame > result.ranges[i - 1]!.endFrame);
    }
    for (const range of result.ranges) {
      assert.ok(range.endFrame > range.startFrame);
    }
  }
  assert.ok(maxRangesPerAnnotation <= 8, `max ranges per annotation: ${maxRangesPerAnnotation}`);
  assert.ok(totalRanges <= 500_000, `total ranges: ${totalRanges}`);

  // 抽样精确核对：第 0 条批注覆盖 S0 的素材 [0,40)，命中位置可解析求出。
  const first = preview.results[0]!;
  assert.equal(first.annotationId, 'ann-0-0');
  assert.deepEqual(first.ranges, [
    { startFrame: 0, endFrame: 20 }, // 4 个短段，每段 5 帧
    { startFrame: 2485, endFrame: 2493 }, // 长段正放 1000 帧：5i 与 [0,40) 相交 -> 帧 0..7
    { startFrame: 3981, endFrame: 3992 }, // 长段倒放帧 496..499 与长段正放帧 0..6 相邻合并
  ]);

  const mib = 1024 * 1024;
  const retainedMiB = (heapRetained - heapBefore) / mib;
  const peakProxyMiB = (heapAfterMigrate - heapBefore) / mib;
  console.log(
    `  [perf] ${newSegments.length} 新段 / ${oldSegments.length} 旧段 / ${annotations.length} 批注`,
  );
  console.log(`  [perf] 结果区间总数: ${totalRanges}，单批注最大区间数: ${maxRangesPerAnnotation}`);
  console.log(`  [perf] 迁移耗时: ${elapsedMs.toFixed(1)} ms（上限 20000 ms）`);
  console.log(
    `  [perf] 堆内存增量: 迁移后未回收 ${peakProxyMiB.toFixed(1)} MiB，` +
      `GC 后常驻 ${retainedMiB.toFixed(1)} MiB（上限 256 MiB）`,
  );
  assert.ok(elapsedMs < 20_000, `migration took ${elapsedMs.toFixed(1)}ms`);
  assert.ok(retainedMiB <= 256, `retained memory ${retainedMiB.toFixed(1)} MiB`);
});
