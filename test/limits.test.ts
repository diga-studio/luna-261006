import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkZipFile } from '../src/index.ts';
import { MAX_ARCHIVE_BYTES, MAX_TOTAL_EXPANDED_BYTES } from '../src/types.ts';
import { buildZip } from './helpers/zipBuilder.ts';
import { writeTempZip, cleanupTempDirs } from './helpers/tmpFile.ts';

after(() => cleanupTempDirs());

const check = (buf: Buffer) => checkZipFile(writeTempZip(buf));

test('声明长度很小但实际展开超过 128 MiB → 超限即停并复核', async () => {
  // 声明 10 字节，实际内容 128 MiB + 1；高压缩比使包体远小于 100 MiB 输入上限
  const content = Buffer.alloc(MAX_TOTAL_EXPANDED_BYTES + 1, 0x41);
  const buf = buildZip([
    {
      name: 'small-claim.bin',
      content,
      cdUncompressedSize: 10,
      localUncompressedSize: 10,
    },
  ]);
  assert.ok(buf.length < 1024 * 1024, '压缩后包体应很小');
  const r = await check(buf);
  assert.equal(r.verdict, 'review');
  assert.ok(r.reasons.includes('expanded-size-limit-exceeded'));
});

test('实际展开恰好等于 128 MiB 上限 → 放行', async () => {
  const content = Buffer.alloc(MAX_TOTAL_EXPANDED_BYTES, 0x42);
  const buf = buildZip([{ name: 'exact.bin', content }]);
  const r = await check(buf);
  assert.equal(r.verdict, 'allow');
});

test('多成员累计展开量超限 → 复核', async () => {
  const half = MAX_TOTAL_EXPANDED_BYTES / 2;
  const buf = buildZip([
    { name: 'p1.bin', content: Buffer.alloc(half, 0x43) },
    { name: 'p2.bin', content: Buffer.alloc(half, 0x44) },
    { name: 'p3.bin', content: Buffer.from('one byte too many') },
  ]);
  const r = await check(buf);
  assert.equal(r.verdict, 'review');
  assert.ok(r.reasons.includes('expanded-size-limit-exceeded'));
});

test('输入文件超过 100 MiB → 复核', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zipcheck-big-'));
  const file = join(dir, 'big.zip');
  writeFileSync(file, Buffer.alloc(MAX_ARCHIVE_BYTES + 1, 0));
  const r = await checkZipFile(file);
  assert.equal(r.verdict, 'review');
  assert.ok(r.reasons.includes('file-too-large'));
});
