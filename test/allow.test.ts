import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { checkZipFile } from '../src/index.ts';
import { buildZip, independentCrc32 } from './helpers/zipBuilder.ts';
import { writeTempZip, cleanupTempDirs } from './helpers/tmpFile.ts';

after(() => cleanupTempDirs());

const allow = async (buf: Buffer) => (await checkZipFile(writeTempZip(buf))).verdict;

test('普通单卷归档（store + deflate + 目录）放行', async () => {
  const buf = buildZip([
    { name: 'docs/', content: Buffer.alloc(0), method: 0 },
    { name: 'docs/readme.txt', content: Buffer.from('hello securevault'), method: 0 },
    { name: 'data/report.csv', content: Buffer.alloc(5000, 120), method: 8 },
  ]);
  assert.equal(await allow(buf), 'allow');
});

test('空归档放行', async () => {
  assert.equal(await allow(buildZip([])), 'allow');
});

test('中央目录乱序仍放行', async () => {
  const buf = buildZip(
    [
      { name: 'a.txt', content: Buffer.from('aaa') },
      { name: 'b.txt', content: Buffer.from('bbb') },
      { name: 'c.txt', content: Buffer.from('ccc') },
      { name: 'd.txt', content: Buffer.from('ddd') },
    ],
    { cdOrder: [2, 0, 3, 1] },
  );
  assert.equal(await allow(buf), 'allow');
});

test('有签名与无签名数据描述符均放行', async () => {
  const buf = buildZip([
    { name: 'signed.bin', content: Buffer.alloc(3000, 7), descriptor: 'signed' },
    { name: 'unsigned.bin', content: Buffer.alloc(3000, 9), descriptor: 'unsigned' },
    { name: 'store-dd.bin', content: Buffer.from('stored with descriptor'), method: 0, descriptor: 'signed' },
  ]);
  assert.equal(await allow(buf), 'allow');
});

test('无签名描述符的 CRC 恰好等于签名值 0x08074b50 仍放行', async () => {
  // 该内容经独立 zlib.crc32 核对，CRC-32 恰为数据描述符签名值
  const content = Buffer.concat([
    Buffer.from('payload-with-crc-equal-to-dd-signature:'),
    Buffer.from([0xb7, 0xc6, 0x87, 0xec]),
  ]);
  assert.equal(independentCrc32(content), 0x08074b50);
  const buf = buildZip([{ name: 'tricky.bin', content, descriptor: 'unsigned' }]);
  assert.equal(await allow(buf), 'allow');
});

test('归档注释与文件注释中含 ZIP 结构签名字节仍放行', async () => {
  const commentWithSigs = Buffer.concat([
    Buffer.from('comment with fake signatures: '),
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x50, 0x4b, 0x01, 0x02, 0x50, 0x4b, 0x05, 0x06]),
  ]);
  const buf = buildZip(
    [
      {
        name: 'note.txt',
        content: Buffer.from('x'.repeat(100)),
        fileComment: commentWithSigs,
      },
    ],
    { archiveComment: commentWithSigs },
  );
  assert.equal(await allow(buf), 'allow');
});

test('严格 UTF-8 名称（设置 UTF-8 标志）放行', async () => {
  const buf = buildZip([
    { name: '文档/报表-2026.txt', content: Buffer.from('utf8 name'), utf8: true },
  ]);
  assert.equal(await allow(buf), 'allow');
});

test('合法成员的内容长度与 CRC 可由独立途径核对', async () => {
  const content = Buffer.alloc(100000, 0x5a);
  const buf = buildZip([{ name: 'big.dat', content }]);
  // 独立解析：本地头后直接取压缩数据，用 zlib 独立展开并核对
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;
  // 从中央目录读取声明值
  const cdSig = 0x02014b50;
  let cdPos = buf.length - 22;
  while (buf.readUInt32LE(cdPos) !== cdSig) cdPos--;
  const declaredCrc = buf.readUInt32LE(cdPos + 16);
  const declaredComp = buf.readUInt32LE(cdPos + 20);
  const declaredSize = buf.readUInt32LE(cdPos + 24);
  const inflated = inflateRawSync(buf.subarray(dataStart, dataStart + declaredComp));
  assert.equal(inflated.length, content.length);
  assert.equal(declaredSize, content.length);
  assert.equal(independentCrc32(inflated), declaredCrc);
  assert.deepEqual(inflated, content);
  assert.equal(await allow(buf), 'allow');
});
