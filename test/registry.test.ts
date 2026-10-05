import { describe, expect, it } from 'vitest';
import { MigrationPreviewer } from '../src/index.js';
import type { ClipSegment } from '../src/index.js';

const segment: ClipSegment = {
  mediaId: 'A',
  sourceStartFrame: 0,
  sourceEndFrame: 100,
  timelineLength: 100,
  direction: 'forward',
};

function makePreviewer(): MigrationPreviewer {
  const previewer = new MigrationPreviewer();
  previewer.registerVersion('v1', [segment]);
  return previewer;
}

describe('登记校验', () => {
  it('重复登记同一版本标识时报错', () => {
    const previewer = makePreviewer();
    expect(() => previewer.registerVersion('v1', [segment])).toThrow(/already registered/);
  });

  it('给未登记的版本登记批注时报错', () => {
    const previewer = makePreviewer();
    expect(() =>
      previewer.registerAnnotations('nope', [{ id: 'a', startFrame: 0, endFrame: 1 }]),
    ).toThrow(/unknown version/);
  });

  it('同一版本内批注标识重复时报错', () => {
    const previewer = makePreviewer();
    previewer.registerAnnotations('v1', [{ id: 'a', startFrame: 0, endFrame: 1 }]);
    expect(() =>
      previewer.registerAnnotations('v1', [{ id: 'a', startFrame: 2, endFrame: 3 }]),
    ).toThrow(/duplicate annotation id/);
  });

  it('批注区间超出成片长度时报错', () => {
    const previewer = makePreviewer();
    expect(() =>
      previewer.registerAnnotations('v1', [{ id: 'a', startFrame: 0, endFrame: 101 }]),
    ).toThrow(/exceeds timeline/);
  });

  it('批注区间起止颠倒时报错', () => {
    const previewer = makePreviewer();
    expect(() =>
      previewer.registerAnnotations('v1', [{ id: 'a', startFrame: 5, endFrame: 3 }]),
    ).toThrow();
  });

  it('对未登记的版本生成预览时报错', () => {
    const previewer = makePreviewer();
    expect(() => previewer.createPreview('v1', 'nope')).toThrow(/unknown version/);
    expect(() => previewer.createPreview('nope', 'v1')).toThrow(/unknown version/);
  });

  it('非法片段参数时报错', () => {
    const previewer = new MigrationPreviewer();
    expect(() =>
      previewer.registerVersion('bad', [{ ...segment, timelineLength: 0 }]),
    ).toThrow(/timelineLength/);
    expect(() =>
      previewer.registerVersion('bad', [{ ...segment, sourceEndFrame: 0 }]),
    ).toThrow(/sourceEndFrame/);
    expect(() =>
      previewer.registerVersion('bad', [{ ...segment, direction: 'sideways' as never }]),
    ).toThrow(/direction/);
  });

  it('批注终点恰好等于成片长度时合法', () => {
    const previewer = makePreviewer();
    previewer.registerVersion('v2', [segment]);
    previewer.registerAnnotations('v1', [{ id: 'tail', startFrame: 90, endFrame: 100 }]);
    const results = previewer.createPreview('v1', 'v2');
    expect(results).toEqual([{ annotationId: 'tail', intervals: [{ startFrame: 90, endFrame: 100 }] }]);
  });

  it('未登记批注的版本生成预览时返回空数组', () => {
    const previewer = makePreviewer();
    previewer.registerVersion('v2', [segment]);
    expect(previewer.createPreview('v1', 'v2')).toEqual([]);
  });
});
