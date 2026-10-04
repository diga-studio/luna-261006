import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkZipFile } from '../src/index.ts';
import { buildZip } from './helpers/zipBuilder.ts';
import { writeTempZip, cleanupTempDirs } from './helpers/tmpFile.ts';

after(() => cleanupTempDirs());

const review = async (buf: Buffer) => (await checkZipFile(writeTempZip(buf))).verdict;
const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const extraField = (id: number, data: Buffer) =>
  Buffer.concat([u16(id), u16(data.length), data]);

test('中央目录与本地记录名称不一致 → 复核', async () => {
  const buf = buildZip([
    { name: 'readme.txt', content: Buffer.from('hello'), cdName: Buffer.from('readme.exe') },
  ]);
  assert.equal(await review(buf), 'review');
});

test('多个中央条目共用同一本地记录 → 复核', async () => {
  const buf = buildZip([
    { name: 'a.txt', content: Buffer.from('aaa') },
    { name: 'b.txt', content: Buffer.from('aaa'), shareLocalOf: 0 },
  ]);
  assert.equal(await review(buf), 'review');
});

test('声明 CRC 与实际内容不符 → 复核', async () => {
  const content = Buffer.from('real content');
  const wrongCrc = 0xdeadbeef;
  const buf = buildZip([
    { name: 'a.txt', content, cdCrc: wrongCrc, localCrc: wrongCrc },
  ]);
  assert.equal(await review(buf), 'review');
});

test('声明的压缩数据范围内夹带尾部字节 → 复核', async () => {
  const content = Buffer.alloc(2000, 65);
  const trailing = Buffer.from([0xaa, 0xbb, 0xcc]);
  const buf = buildZip([
    {
      name: 'a.txt',
      content,
      trailingBytesAfterData: trailing,
      // 声明的压缩长度把脏字节也算进数据区
      cdCompressedSize: undefined,
      localCompressedSize: undefined,
    },
  ]);
  // 重新构造：让声明的压缩长度包含尾部字节
  const { deflateRawSync } = await import('node:zlib');
  const compLen = deflateRawSync(content).length + trailing.length;
  const buf2 = buildZip([
    {
      name: 'a.txt',
      content,
      trailingBytesAfterData: trailing,
      cdCompressedSize: compLen,
      localCompressedSize: compLen,
    },
  ]);
  void buf;
  assert.equal(await review(buf2), 'review');
});

test('归档前置字节 → 复核', async () => {
  const buf = buildZip([{ name: 'a.txt', content: Buffer.from('x') }], {
    prefix: Buffer.from('MZ'),
  });
  assert.equal(await review(buf), 'review');
});

test('归档尾随字节 → 复核', async () => {
  const buf = buildZip([{ name: 'a.txt', content: Buffer.from('x') }], {
    suffix: Buffer.from('trailing'),
  });
  assert.equal(await review(buf), 'review');
});

test('记录之间的无归属字节 → 复核', async () => {
  const buf = buildZip([
    { name: 'a.txt', content: Buffer.from('x'), trailingBytesAfterData: Buffer.from('junk') },
  ]);
  assert.equal(await review(buf), 'review');
});

test('加密标志 → 复核', async () => {
  const buf = buildZip([{ name: 'a.txt', content: Buffer.from('x'), flagsOverride: 0x0001 }]);
  assert.equal(await review(buf), 'review');
});

test('未设 UTF-8 标志的非 ASCII 名称 → 复核', async () => {
  const buf = buildZip([
    { name: Buffer.from([0xe4, 0xb8, 0xad, 0x2e, 0x74, 0x78, 0x74]), content: Buffer.from('x') },
  ]);
  assert.equal(await review(buf), 'review');
});

test('ZIP64 扩展字段 → 复核', async () => {
  const buf = buildZip([
    { name: 'a.txt', content: Buffer.from('x'), extra: extraField(0x0001, Buffer.alloc(0)) },
  ]);
  assert.equal(await review(buf), 'review');
});

test('Unicode Path 改名扩展 → 复核', async () => {
  const buf = buildZip([
    {
      name: 'a.txt',
      content: Buffer.from('x'),
      extra: extraField(0x7075, Buffer.from([1, 0, 0, 0, 0])),
    },
  ]);
  assert.equal(await review(buf), 'review');
});

test('不支持的压缩方式 → 复核', async () => {
  const buf = buildZip([{ name: 'a.txt', content: Buffer.from('x'), method: 12 }]);
  assert.equal(await review(buf), 'review');
});

test('数据描述符与中央目录不一致 → 复核', async () => {
  const buf = buildZip([
    { name: 'a.txt', content: Buffer.from('x'.repeat(100)), descriptor: 'signed', cdCrc: 0x12345678 },
  ]);
  assert.equal(await review(buf), 'review');
});

test('目录成员实际内容非空 → 复核', async () => {
  const buf = buildZip([{ name: 'dir/', content: Buffer.from('not empty') }]);
  assert.equal(await review(buf), 'review');
});

test('无描述符时本地头与中央目录长度不一致 → 复核', async () => {
  const buf = buildZip([
    { name: 'a.txt', content: Buffer.from('x'.repeat(50)), localUncompressedSize: 51 },
  ]);
  assert.equal(await review(buf), 'review');
});

test('Deflate 数据被截断 → 复核', async () => {
  const content = Buffer.alloc(4000, 66);
  const { deflateRawSync } = await import('node:zlib');
  const compLen = deflateRawSync(content).length;
  const buf = buildZip([
    {
      name: 'a.txt',
      content,
      cdCompressedSize: compLen - 2,
      localCompressedSize: compLen - 2,
    },
  ]);
  assert.equal(await review(buf), 'review');
});
