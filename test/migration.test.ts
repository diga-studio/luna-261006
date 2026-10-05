import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MigrationRegistry,
  type AnnotationInput,
  type AnnotationMigration,
  type SegmentInput,
} from '../src/index.js';
import { bruteForceMigrate, makeRng, totalFrames } from './helpers.js';

function migrateRaw(
  oldSegments: readonly SegmentInput[],
  newSegments: readonly SegmentInput[],
  annotations: readonly AnnotationInput[],
): AnnotationMigration[] {
  const registry = new MigrationRegistry();
  registry.registerVersion('old', oldSegments);
  registry.registerVersion('new', newSegments);
  registry.registerAnnotations('old', annotations);
  return [...registry.migrate('old', 'new').results];
}

function seg(
  sourceId: string,
  sourceStart: number,
  sourceEnd: number,
  duration: number,
  direction: 'forward' | 'reverse' = 'forward',
): SegmentInput {
  return { sourceId, sourceStart, sourceEnd, duration, direction };
}

test('非整数变速正放：边界帧精确，端点相碰不算命中', () => {
  // 旧版：素材 A [0,100] 压进 50 帧（2 倍速）。批注 [10,20) 覆盖素材 [20,40)。
  const oldSegs = [seg('A', 0, 100, 50)];
  // 新版：素材 A [0,100] 拉成 30 帧。帧 i 覆盖 [10i/3, 10(i+1)/3]。
  // 帧 5 止于 20（仅相碰，排除），帧 6 起于 20（含），帧 11 止于 40（含），帧 12 起于 40（仅相碰，排除）。
  const newSegs = [seg('A', 0, 100, 30)];
  const [result] = migrateRaw(oldSegs, newSegs, [{ id: 'a1', startFrame: 10, endFrame: 20 }]);
  assert.deepEqual(result!.ranges, [{ startFrame: 6, endFrame: 12 }]);
});

test('非整数变速倒放：边界帧精确', () => {
  const oldSegs = [seg('A', 0, 100, 50)];
  // 倒放：帧 i 覆盖 [100-10(i+1)/3, 100-10i/3]。命中帧 18..23。
  const newSegs = [seg('A', 0, 100, 30, 'reverse')];
  const [result] = migrateRaw(oldSegs, newSegs, [{ id: 'a1', startFrame: 10, endFrame: 20 }]);
  assert.deepEqual(result!.ranges, [{ startFrame: 18, endFrame: 24 }]);
});

test('跨段批注 + 重复引用：所有副本均命中', () => {
  // 旧版两段：A[0,50] 原速 50 帧，A[50,100] 二倍速 25 帧。
  // 批注 [40,60) 跨两段，覆盖素材 [40,50) 与 [50,70)。
  const oldSegs = [seg('A', 0, 50, 50), seg('A', 50, 100, 25)];
  // 新版引用同一素材三次：原速正放、原速倒放、再正放一次。
  const newSegs = [
    seg('A', 0, 100, 100),
    seg('B', 0, 10, 10),
    seg('A', 0, 100, 100, 'reverse'),
    seg('A', 0, 100, 100),
  ];
  const [result] = migrateRaw(oldSegs, newSegs, [{ id: 'a1', startFrame: 40, endFrame: 60 }]);
  assert.deepEqual(result!.ranges, [
    { startFrame: 40, endFrame: 70 }, // 正放副本
    { startFrame: 110 + 30, endFrame: 110 + 60 }, // 倒放副本（帧 30..59）
    { startFrame: 210 + 40, endFrame: 210 + 70 }, // 第二个正放副本
  ]);
});

test('仅端点相触：结果为空', () => {
  const oldSegs = [seg('A', 0, 10, 10)];
  const newSegs = [seg('A', 10, 20, 10)];
  const [result] = migrateRaw(oldSegs, newSegs, [{ id: 'a1', startFrame: 0, endFrame: 10 }]);
  assert.deepEqual(result!.ranges, []);
});

test('变速后仅端点相触：结果为空', () => {
  // 批注覆盖素材 [20,40)；新段素材从 40 开始。
  const oldSegs = [seg('A', 0, 100, 50)];
  const newSegs = [seg('A', 40, 100, 30)];
  const [result] = migrateRaw(oldSegs, newSegs, [{ id: 'a1', startFrame: 10, endFrame: 20 }]);
  assert.deepEqual(result!.ranges, []);
});

test('内容全部删除：结果为空', () => {
  const oldSegs = [seg('A', 0, 10, 10)];
  const newSegs = [seg('B', 0, 10, 10)];
  const [result] = migrateRaw(oldSegs, newSegs, [{ id: 'a1', startFrame: 0, endFrame: 10 }]);
  assert.deepEqual(result!.ranges, []);
});

test('不同素材即使范围相同也不匹配', () => {
  const oldSegs = [seg('A', 0, 10, 10)];
  const newSegs = [seg('B', 0, 10, 10)];
  const [result] = migrateRaw(oldSegs, newSegs, [{ id: 'a1', startFrame: 0, endFrame: 5 }]);
  assert.deepEqual(result!.ranges, []);
});

test('单点批注按覆盖一个完整帧处理', () => {
  const oldSegs = [seg('A', 0, 100, 100)];
  const newSegs = [seg('A', 0, 100, 100)];
  const [result] = migrateRaw(oldSegs, newSegs, [{ id: 'a1', startFrame: 7, endFrame: 7 }]);
  assert.deepEqual(result!.ranges, [{ startFrame: 7, endFrame: 8 }]);
});

test('相邻区间合并，不同批注不合并', () => {
  const oldSegs = [seg('A', 0, 100, 100)];
  // 新版两段相邻拼接，各自命中后应合并为一个区间。
  const newSegs = [seg('A', 0, 50, 50), seg('A', 50, 100, 50)];
  const results = migrateRaw(oldSegs, newSegs, [
    { id: 'a1', startFrame: 10, endFrame: 90 },
    { id: 'a2', startFrame: 20, endFrame: 30 },
  ]);
  assert.deepEqual(results[0]!.ranges, [{ startFrame: 10, endFrame: 90 }]);
  assert.deepEqual(results[1]!.ranges, [{ startFrame: 20, endFrame: 30 }]);
});

test('每条批注都有独立结果，顺序与登记一致', () => {
  const oldSegs = [seg('A', 0, 10, 10)];
  const newSegs = [seg('A', 0, 10, 10)];
  const results = migrateRaw(oldSegs, newSegs, [
    { id: 'x', startFrame: 0, endFrame: 1 },
    { id: 'y', startFrame: 5, endFrame: 6 },
    { id: 'z', startFrame: 9, endFrame: 10 },
  ]);
  assert.deepEqual(
    results.map((r) => r.annotationId),
    ['x', 'y', 'z'],
  );
});

test('迁移预览不修改已登记的旧批注', () => {
  const registry = new MigrationRegistry();
  registry.registerVersion('old', [seg('A', 0, 10, 10)]);
  registry.registerVersion('new', [seg('A', 0, 10, 10)]);
  const annotations: AnnotationInput[] = [{ id: 'a1', startFrame: 2, endFrame: 5 }];
  registry.registerAnnotations('old', annotations);
  registry.migrate('old', 'new');
  assert.deepEqual(annotations[0], { id: 'a1', startFrame: 2, endFrame: 5 });
  // 再次迁移结果一致（无内部状态污染）。
  const first = registry.migrate('old', 'new');
  const second = registry.migrate('old', 'new');
  assert.deepEqual(first, second);
});

test('输入校验', () => {
  const registry = new MigrationRegistry();
  registry.registerVersion('v1', [seg('A', 0, 10, 10)]);
  assert.throws(() => registry.registerVersion('v1', []), /already registered/);
  assert.throws(() => registry.registerAnnotations('nope', []), /not registered/);
  assert.throws(() => registry.migrate('v1', 'nope'), /not registered/);
  assert.throws(
    () => registry.registerVersion('bad', [seg('A', 10, 10, 10)]),
    /sourceEnd/,
  );
  assert.throws(() => registry.registerVersion('bad', [seg('A', 0, 10, 0)]), /duration/);
  assert.throws(
    () => registry.registerVersion('bad', [seg('A', 0, 10, 1.5)]),
    /safe integer/,
  );
  registry.registerAnnotations('v1', [{ id: 'a1', startFrame: 0, endFrame: 5 }]);
  assert.throws(
    () => registry.registerAnnotations('v1', [{ id: 'a1', startFrame: 0, endFrame: 1 }]),
    /duplicate/,
  );
  assert.throws(
    () => registry.registerAnnotations('v1', [{ id: 'a2', startFrame: 5, endFrame: 2 }]),
    /endFrame/,
  );
  assert.throws(
    () => registry.registerAnnotations('v1', [{ id: 'a3', startFrame: 0, endFrame: 11 }]),
    /total frames/,
  );
});

test('随机场景与逐帧暴力参考完全一致', () => {
  const rng = makeRng(20261006);
  const sourceIds = ['A', 'B', 'C'];
  for (let iter = 0; iter < 400; iter++) {
    const makeVersion = (): SegmentInput[] => {
      const count = 1 + Math.floor(rng() * 8);
      const segments: SegmentInput[] = [];
      for (let i = 0; i < count; i++) {
        const sourceStart = Math.floor(rng() * 200);
        const sourceEnd = sourceStart + 1 + Math.floor(rng() * 60);
        const duration = 1 + Math.floor(rng() * 40);
        const direction = rng() < 0.5 ? 'forward' : 'reverse';
        const sourceId = sourceIds[Math.floor(rng() * sourceIds.length)]!;
        segments.push({ sourceId, sourceStart, sourceEnd, duration, direction });
      }
      return segments;
    };
    const oldSegs = makeVersion();
    const newSegs = makeVersion();
    const oldTotal = totalFrames(oldSegs);
    const annotations: AnnotationInput[] = [];
    const annotationCount = 1 + Math.floor(rng() * 12);
    for (let i = 0; i < annotationCount; i++) {
      const startFrame = Math.floor(rng() * oldTotal);
      const length = Math.floor(rng() * 30);
      const endFrame = Math.min(oldTotal, startFrame + length);
      annotations.push({ id: `ann${i}`, startFrame, endFrame });
    }
    const results = migrateRaw(oldSegs, newSegs, annotations);
    assert.equal(results.length, annotations.length);
    for (let i = 0; i < annotations.length; i++) {
      const expected = bruteForceMigrate(oldSegs, newSegs, annotations[i]!);
      assert.deepEqual(
        results[i]!.ranges,
        expected,
        `iter=${iter} annotation=${JSON.stringify(annotations[i])}\nold=${JSON.stringify(
          oldSegs,
        )}\nnew=${JSON.stringify(newSegs)}`,
      );
    }
  }
});
