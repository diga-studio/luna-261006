import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, truncate } from 'node:fs/promises';
import { verifyFile, VerifyError, type TrustedManifest } from '../src/index.js';
import { buildFixture, makeFixtureDir, type Fixture } from './mp4Builder.js';

let dir: string;

before(async () => {
  dir = await makeFixtureDir();
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function expectReject(path: string, manifest: TrustedManifest, code: string): Promise<void> {
  await assert.rejects(
    verifyFile(path, manifest),
    (err: unknown) => {
      assert.ok(err instanceof VerifyError, `expected VerifyError, got ${err}`);
      assert.equal(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
      return true;
    },
  );
}

test('合法文件（无 B 帧、无 elst、moov 在尾部）通过', async () => {
  const fx = await buildFixture(dir, 'basic', {});
  const result = await verifyFile(fx.path, fx.manifest);
  assert.equal(result.ok, true);
  assert.equal(result.frameCount, 120);
  // 展示时间轴独立核算：第 i 帧恰在 i/fps 秒
  for (let i = 0; i < fx.presentationTimes.length; i++) {
    assert.equal(fx.presentationTimes[i], BigInt(i) * fx.frameDuration);
  }
});

test('含 B 帧与非零媒体起点（ctts v1、多帧共块、moov 前置、v1 时间头）通过', async () => {
  const fx = await buildFixture(dir, 'bframes', {
    bFrames: true,
    mediaStartFrames: 3,
    cttsVersion: 1,
    framesPerChunk: 3,
    moovFirst: true,
    headerVersion: 1,
  });
  const result = await verifyFile(fx.path, fx.manifest);
  assert.equal(result.ok, true);
  const mediaStart = 3n * fx.frameDuration;
  for (let i = 0; i < fx.presentationTimes.length; i++) {
    assert.equal(fx.presentationTimes[i]! - mediaStart, BigInt(i) * fx.frameDuration);
  }
});

test('ctts v0 + elst 平移（媒体起点 1 帧）通过', async () => {
  const fx = await buildFixture(dir, 'cttsv0', {
    bFrames: true,
    mediaStartFrames: 1,
    cttsVersion: 0,
    frameRate: 30,
    elstVersion: 1,
  });
  const result = await verifyFile(fx.path, fx.manifest);
  assert.equal(result.ok, true);
});

test('清单哈希错序被拒绝', async () => {
  const fx = await buildFixture(dir, 'swap', {});
  const hashes = [...fx.manifest.frameSha256];
  [hashes[0], hashes[1]] = [hashes[1]!, hashes[0]!];
  await expectReject(fx.path, { ...fx.manifest, frameSha256: hashes }, 'HASH_MISMATCH');
});

test('mdhd 时长偏移一个媒体时钟刻度被拒绝', async () => {
  const fx = await buildFixture(dir, 'mdhd-off', { mdhdDurationDelta: 1n });
  await expectReject(fx.path, fx.manifest, 'DURATION_MISMATCH');
});

test('mvhd 时长偏移一个时钟刻度被拒绝', async () => {
  const fx = await buildFixture(dir, 'mvhd-off', { mvhdDurationDelta: -1n });
  await expectReject(fx.path, fx.manifest, 'DURATION_MISMATCH');
});

test('样本指向非 mdat 区域被拒绝', async () => {
  const fx = await buildFixture(dir, 'bad-offset', { corruptChunkOffset: true });
  await expectReject(fx.path, fx.manifest, 'TRACK_LAYOUT');
});

test('多 mdat、多帧共块、乱序块、4 GiB 后样本、定长 stsz、co64、末尾长度 0 的合法文件通过且满足资源要求', async () => {
  const fx = await buildFixture(dir, 'big', {
    frameRate: 12,
    bFrames: true,
    mediaStartFrames: 1,
    cttsVersion: 0,
    framesPerChunk: 4,
    mdatCount: 3,
    shuffleChunks: true,
    fixedStsz: true,
    moovFirst: true,
    headerVersion: 1,
    lastMdatSizeZero: true,
    padMdatTo: (4n << 30n) + (64n << 20n),
  });
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const result = await verifyFile(fx.path, fx.manifest);
  const elapsed = performance.now() - start;
  gc?.();
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;
  assert.equal(result.ok, true);
  assert.equal(result.frameCount, 60);
  assert.ok(elapsed < 2000, `verification took ${elapsed.toFixed(0)}ms`);
  assert.ok(heapDelta < 64 * 1024 * 1024, `heap delta ${heapDelta} bytes`);
});

test('两个样本展示时刻相同被拒绝', async () => {
  const fx = await buildFixture(dir, 'dup-pts', { duplicatePts: true });
  await expectReject(fx.path, fx.manifest, 'TIMELINE');
});

test('截断文件被拒绝', async () => {
  const fx = await buildFixture(dir, 'truncated', {});
  await truncate(fx.path, (await import('node:fs')).statSync(fx.path).size - 7);
  await assert.rejects(verifyFile(fx.path, fx.manifest), VerifyError);
});

test('样本数与清单不符被拒绝', async () => {
  const fx = await buildFixture(dir, 'ten-sec', { durationSeconds: 10 });
  const manifest: TrustedManifest = {
    ...fx.manifest,
    durationSeconds: 5,
    frameSha256: fx.manifest.frameSha256.slice(0, 120),
  };
  await expectReject(fx.path, manifest, 'FRAME_COUNT_MISMATCH');
});

test('宽高与清单不符被拒绝', async () => {
  const fx = await buildFixture(dir, 'geometry', {});
  await expectReject(fx.path, { ...fx.manifest, width: fx.manifest.width + 16 }, 'GEOMETRY_MISMATCH');
});

test('样本表计数不一致被拒绝', async () => {
  const fx = await buildFixture(dir, 'stsz-extra', { stszExtraCount: 3 });
  await expectReject(fx.path, fx.manifest, 'SAMPLE_TABLE');
});

test('elst 多片段被拒绝', async () => {
  const fx = await buildFixture(dir, 'elst2', { mediaStartFrames: 2, elstEntries: 2 });
  await expectReject(fx.path, fx.manifest, 'UNSUPPORTED');
});

test('elst 播放速率非 1 被拒绝', async () => {
  const fx = await buildFixture(dir, 'elst-rate', { mediaStartFrames: 2, elstRate: 2 });
  await expectReject(fx.path, fx.manifest, 'UNSUPPORTED');
});

test('末尾 8 字节空 free box 的合法文件通过', async () => {
  const fx = await buildFixture(dir, 'trailing-free', { moovFirst: true, trailingEmptyFree: true });
  const result = await verifyFile(fx.path, fx.manifest);
  assert.equal(result.ok, true);
});

test('非法清单被拒绝', async () => {
  const fx = await buildFixture(dir, 'bad-manifest', {});
  await expectReject(fx.path, { ...fx.manifest, frameRate: 25 }, 'BAD_MANIFEST');
  await expectReject(fx.path, { ...fx.manifest, durationSeconds: 7 }, 'BAD_MANIFEST');
});
