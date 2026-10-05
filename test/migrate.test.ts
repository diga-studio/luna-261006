import { describe, expect, it } from 'vitest';
import { MigrationPreviewer } from '../src/index.js';
import type { Annotation, ClipSegment, FrameInterval } from '../src/index.js';
import { bruteForceMigrate } from './helpers.js';

function seg(
  mediaId: string,
  sourceStartFrame: number,
  sourceEndFrame: number,
  timelineLength: number,
  direction: 'forward' | 'reverse' = 'forward',
): ClipSegment {
  return { mediaId, sourceStartFrame, sourceEndFrame, timelineLength, direction };
}

function preview(
  oldSegments: ClipSegment[],
  newSegments: ClipSegment[],
  annotations: Annotation[],
) {
  const previewer = new MigrationPreviewer();
  previewer.registerVersion('old', oldSegments);
  previewer.registerVersion('new', newSegments);
  previewer.registerAnnotations('old', annotations);
  return previewer.createPreview('old', 'new');
}

function expectMatchesBruteForce(
  oldSegments: ClipSegment[],
  newSegments: ClipSegment[],
  annotations: Annotation[],
) {
  const results = preview(oldSegments, newSegments, annotations);
  expect(results.length).toBe(annotations.length);
  for (let i = 0; i < annotations.length; i++) {
    expect(results[i].annotationId).toBe(annotations[i].id);
    const expected = bruteForceMigrate(oldSegments, newSegments, annotations[i]);
    expect(results[i].intervals).toEqual(expected);
  }
}

describe('基本迁移', () => {
  it('同一素材被重复引用时所有副本都命中', () => {
    const oldSegments = [seg('A', 0, 100, 100)];
    const newSegments = [
      seg('A', 0, 100, 100),
      seg('B', 0, 10, 10),
      seg('A', 0, 100, 100),
      seg('A', 0, 100, 100),
    ];
    const annotations = [{ id: 'a1', startFrame: 10, endFrame: 20 }];
    const results = preview(oldSegments, newSegments, annotations);
    expect(results).toHaveLength(1);
    expect(results[0].intervals).toEqual([
      { startFrame: 10, endFrame: 20 },
      { startFrame: 120, endFrame: 130 },
      { startFrame: 220, endFrame: 230 },
    ] satisfies FrameInterval[]);
    expectMatchesBruteForce(oldSegments, newSegments, annotations);
  });

  it('倒放片段按同一覆盖规则命中', () => {
    const oldSegments = [seg('A', 0, 100, 100)];
    const newSegments = [seg('A', 0, 100, 100, 'reverse')];
    const annotations = [{ id: 'a1', startFrame: 10, endFrame: 20 }];
    // 素材 [10,20) 在倒放片段中落在成片帧 [80,90)。
    const results = preview(oldSegments, newSegments, annotations);
    expect(results[0].intervals).toEqual([{ startFrame: 80, endFrame: 90 }]);
    expectMatchesBruteForce(oldSegments, newSegments, annotations);
  });

  it('非整数倍速：10 帧素材压成 3 帧', () => {
    const oldSegments = [seg('A', 0, 10, 10)];
    const newSegments = [seg('A', 0, 10, 3)];
    // 批注 [4,5) 覆盖素材 [4,5)，只与切片 1 ([10/3,20/3)) 相交。
    const annotations = [
      { id: 'a1', startFrame: 4, endFrame: 5 },
      { id: 'a2', startFrame: 3, endFrame: 4 },
    ];
    const results = preview(oldSegments, newSegments, annotations);
    expect(results[0].intervals).toEqual([{ startFrame: 1, endFrame: 2 }]);
    // 素材 [3,4) 与切片 0 ([0,10/3)) 和切片 1 都有正长度交集。
    expect(results[1].intervals).toEqual([{ startFrame: 0, endFrame: 2 }]);
    expectMatchesBruteForce(oldSegments, newSegments, annotations);
  });

  it('跨段批注在重复引用、倒放、变速混合的新版中迁移', () => {
    const oldSegments = [seg('A', 0, 50, 50), seg('B', 0, 30, 30)];
    const newSegments = [
      seg('A', 0, 50, 50, 'reverse'),
      seg('A', 0, 50, 25),
      seg('B', 0, 30, 60),
      seg('B', 10, 20, 5, 'reverse'),
    ];
    const annotations = [{ id: 'cross', startFrame: 40, endFrame: 60 }];
    expectMatchesBruteForce(oldSegments, newSegments, annotations);
    const results = preview(oldSegments, newSegments, annotations);
    // A 倒放命中 [0,10)；A 二倍速命中 [70,75)；B 半速命中 [75,95)，相邻合并为 [70,95)。
    expect(results[0].intervals).toEqual([
      { startFrame: 0, endFrame: 10 },
      { startFrame: 70, endFrame: 95 },
    ]);
  });

  it('相邻命中区间合并为一条', () => {
    const oldSegments = [seg('A', 0, 10, 10)];
    const newSegments = [seg('A', 0, 5, 5), seg('A', 5, 10, 5)];
    const annotations = [{ id: 'a1', startFrame: 0, endFrame: 10 }];
    const results = preview(oldSegments, newSegments, annotations);
    expect(results[0].intervals).toEqual([{ startFrame: 0, endFrame: 10 }]);
  });

  it('单点批注按覆盖一个完整成片帧处理', () => {
    const oldSegments = [seg('A', 0, 10, 10)];
    const newSegments = [seg('A', 0, 10, 10)];
    const annotations = [{ id: 'point', startFrame: 7, endFrame: 7 }];
    const results = preview(oldSegments, newSegments, annotations);
    expect(results[0].intervals).toEqual([{ startFrame: 7, endFrame: 8 }]);
    expectMatchesBruteForce(oldSegments, newSegments, annotations);
  });
});

describe('空结果', () => {
  it('仅端点相碰不算命中', () => {
    const oldSegments = [seg('A', 0, 10, 10)];
    // 新版素材范围 [5,10) 与批注素材范围 [0,5) 仅在端点 5 相碰。
    const newSegments = [seg('A', 5, 10, 5)];
    const annotations = [{ id: 'a1', startFrame: 0, endFrame: 5 }];
    const results = preview(oldSegments, newSegments, annotations);
    expect(results).toHaveLength(1);
    expect(results[0].annotationId).toBe('a1');
    expect(results[0].intervals).toEqual([]);
    expectMatchesBruteForce(oldSegments, newSegments, annotations);
  });

  it('素材覆盖范围端点相碰（变速后）仍为空', () => {
    // 旧版 10 帧素材压成 5 帧：批注帧 [0,1) 覆盖素材 [0,2)。
    const oldSegments = [seg('A', 0, 10, 5)];
    // 新版素材从 2 开始，仅在端点 2 相碰。
    const newSegments = [seg('A', 2, 10, 8)];
    const annotations = [{ id: 'a1', startFrame: 0, endFrame: 1 }];
    const results = preview(oldSegments, newSegments, annotations);
    expect(results[0].intervals).toEqual([]);
    expectMatchesBruteForce(oldSegments, newSegments, annotations);
  });

  it('批注内容全部删除时返回空结果', () => {
    const oldSegments = [seg('A', 0, 100, 100)];
    const newSegments = [seg('B', 0, 50, 50), seg('A', 60, 100, 40)];
    const annotations = [{ id: 'gone', startFrame: 10, endFrame: 30 }];
    const results = preview(oldSegments, newSegments, annotations);
    expect(results).toHaveLength(1);
    expect(results[0].intervals).toEqual([]);
  });

  it('新版完全为空时所有批注都是空结果', () => {
    const oldSegments = [seg('A', 0, 10, 10)];
    const annotations = [
      { id: 'a1', startFrame: 0, endFrame: 5 },
      { id: 'a2', startFrame: 5, endFrame: 10 },
    ];
    const results = preview(oldSegments, [], annotations);
    expect(results).toHaveLength(2);
    expect(results[0].intervals).toEqual([]);
    expect(results[1].intervals).toEqual([]);
  });
});

describe('结果独立性', () => {
  it('每条旧批注都有独立结果，不同批注之间不合并', () => {
    const oldSegments = [seg('A', 0, 10, 10)];
    const newSegments = [seg('A', 0, 10, 10)];
    const annotations = [
      { id: 'a1', startFrame: 0, endFrame: 5 },
      { id: 'a2', startFrame: 5, endFrame: 10 },
    ];
    const results = preview(oldSegments, newSegments, annotations);
    expect(results.map((r) => r.annotationId)).toEqual(['a1', 'a2']);
    expect(results[0].intervals).toEqual([{ startFrame: 0, endFrame: 5 }]);
    expect(results[1].intervals).toEqual([{ startFrame: 5, endFrame: 10 }]);
  });

  it('迁移预览不修改旧批注输入', () => {
    const oldSegments = [seg('A', 0, 10, 10)];
    const newSegments = [seg('A', 0, 10, 10)];
    const annotations = [{ id: 'a1', startFrame: 2, endFrame: 8 }];
    const snapshot = JSON.parse(JSON.stringify(annotations));
    preview(oldSegments, newSegments, annotations);
    expect(annotations).toEqual(snapshot);
  });
});
