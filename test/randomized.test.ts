import { describe, expect, it } from 'vitest';
import { MigrationPreviewer } from '../src/index.js';
import type { Annotation, ClipSegment } from '../src/index.js';
import { bruteForceMigrate } from './helpers.js';

/** 确定性伪随机数生成器（mulberry32）。 */
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

function randomTimeline(rng: () => number, mediaPool: string[], sourceBase: number): ClipSegment[] {
  const count = 1 + Math.floor(rng() * 8);
  const segments: ClipSegment[] = [];
  for (let i = 0; i < count; i++) {
    const mediaId = mediaPool[Math.floor(rng() * mediaPool.length)];
    const start = sourceBase + Math.floor(rng() * 150);
    const sourceLen = 1 + Math.floor(rng() * 50);
    const timelineLength = 1 + Math.floor(rng() * 30);
    segments.push({
      mediaId,
      sourceStartFrame: start,
      sourceEndFrame: start + sourceLen,
      timelineLength,
      direction: rng() < 0.5 ? 'forward' : 'reverse',
    });
  }
  return segments;
}

function randomAnnotations(rng: () => number, totalFrames: number, count: number): Annotation[] {
  const annotations: Annotation[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(rng() * totalFrames);
    const isPoint = rng() < 0.15;
    const end = isPoint ? start : Math.min(totalFrames, start + 1 + Math.floor(rng() * 40));
    annotations.push({ id: `ann-${i}`, startFrame: start, endFrame: end });
  }
  return annotations;
}

function runCase(seed: number, sourceBase: number) {
  const rng = makeRng(seed);
  const mediaPool = ['A', 'B', 'C'];
  const oldSegments = randomTimeline(rng, mediaPool, sourceBase);
  const newSegments = randomTimeline(rng, mediaPool, sourceBase);
  const oldTotal = oldSegments.reduce((acc, s) => acc + s.timelineLength, 0);
  const annotations = randomAnnotations(rng, oldTotal, 12);

  const previewer = new MigrationPreviewer();
  previewer.registerVersion('old', oldSegments);
  previewer.registerVersion('new', newSegments);
  previewer.registerAnnotations('old', annotations);
  const results = previewer.createPreview('old', 'new');

  expect(results).toHaveLength(annotations.length);
  for (let i = 0; i < annotations.length; i++) {
    const expected = bruteForceMigrate(oldSegments, newSegments, annotations[i]);
    expect(results[i].annotationId).toBe(annotations[i].id);
    expect(results[i].intervals).toEqual(expected);
  }
}

describe('随机小规模与逐帧暴力结果一致', () => {
  it('普通素材编号，300 组随机用例', () => {
    for (let seed = 1; seed <= 300; seed++) {
      runCase(seed, 0);
    }
  });

  it('大素材编号（2^40 附近）仍精确，100 组随机用例', () => {
    const base = 2 ** 40;
    for (let seed = 1000; seed < 1100; seed++) {
      runCase(seed, base);
    }
  });
});
