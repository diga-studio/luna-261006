import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectZipDetailed } from '../src/inspect';
import { Verdict } from '../src/types';
import { buildZip, crc32Independent, findCrcPreimage, BuiltZip } from './zipBuilder';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const workDir = mkdtempSync(join(tmpdir(), 'zip-inspect-'));
let fileCounter = 0;

async function verdictOf(buffer: Buffer): Promise<{ verdict: Verdict; reason: string }> {
  fileCounter += 1;
  const filePath = join(workDir, `case-${fileCounter}.zip`);
  writeFileSync(filePath, buffer);
  return inspectZipDetailed(filePath);
}

async function expectVerdict(buffer: Buffer, expected: Verdict): Promise<string> {
  const result = await verdictOf(buffer);
  assert.strictEqual(
    result.verdict,
    expected,
    `expected ${expected}, got ${result.verdict} (${result.reason})`,
  );
  return result.reason;
}

// ---------- 独立实现自核对 ----------

test('独立 CRC-32 实现与标准向量一致', () => {
  assert.strictEqual(crc32Independent(Buffer.from('123456789', 'latin1')), 0xcbf43926);
  assert.strictEqual(crc32Independent(Buffer.alloc(0)), 0);
});

// ---------- 放行场景 ----------

test('空归档放行', async () => {
  const built = buildZip([]);
  assert.strictEqual(built.buffer.length, 22);
  await expectVerdict(built.buffer, 'allow');
});

test('乱序中央目录、混合方法、注释含结构签名字节仍放行', async () => {
  const textData = Buffer.from('hello secure vault, hello secure vault', 'utf8');
  const sigLikeData = Buffer.from([
    0x50, 0x4b, 0x03, 0x04, 0x50, 0x4b, 0x01, 0x02, 0x50, 0x4b, 0x05, 0x06,
  ]);
  assert.strictEqual(textData.length, 38);
  assert.strictEqual(sigLikeData.length, 12);
  const archiveComment = Buffer.concat([
    Buffer.from('release notes '),
    Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x50, 0x4b, 0x03, 0x04]),
  ]);
  const built = buildZip(
    [
      { name: 'docs/readme.txt', data: textData, method: 8 },
      { name: 'empty-dir/', method: 0 },
      { name: 'payload.bin', data: sigLikeData, method: 0, comment: Buffer.from('pk\x01\x02') },
      { name: '报表.txt', data: Buffer.from('utf8 名称内容', 'utf8'), method: 8 },
    ],
    { archiveComment, centralOrder: [2, 0, 3, 1] },
  );
  await expectVerdict(built.buffer, 'allow');
});

test('两种数据描述符与签名同值 CRC 的无签名描述符均放行', async () => {
  const signedData = Buffer.from('signed descriptor content, deflate me', 'utf8');
  const unsignedData = Buffer.from('unsigned descriptor content', 'utf8');
  const sigCrcData = findCrcPreimage(0x08074b50);
  assert.strictEqual(signedData.length, 37);
  assert.strictEqual(unsignedData.length, 27);
  assert.strictEqual(sigCrcData.length, 4);
  assert.strictEqual(crc32Independent(sigCrcData), 0x08074b50);
  const built = buildZip([
    { name: 'a.bin', data: signedData, method: 8, descriptor: 'signed' },
    { name: 'b.bin', data: unsignedData, method: 8, descriptor: 'unsigned' },
    { name: 'c.bin', data: sigCrcData, method: 8, descriptor: 'unsigned' },
    { name: 'd.bin', data: signedData, method: 8, descriptor: 'signed', descriptorLocalValues: 'real' },
    { name: 'e.bin', data: unsignedData, method: 0, descriptor: 'unsigned' },
  ]);
  await expectVerdict(built.buffer, 'allow');
});

test('可忽略的未知额外字段不影响放行', async () => {
  const extra = Buffer.concat([
    Buffer.from([0x09, 0x99, 0x03, 0x00, 1, 2, 3]),
    Buffer.from([0xfe, 0xca, 0x00, 0x00]),
  ]);
  const built = buildZip([{ name: 'x.txt', data: Buffer.from('extra ok'), extra }]);
  await expectVerdict(built.buffer, 'allow');
});

test('累计展开量恰好 128 MiB 放行', async () => {
  const data = Buffer.alloc(128 * 1024 * 1024, 0x5a);
  assert.strictEqual(data.length, 134217728);
  const built = buildZip([{ name: 'big.bin', data, method: 8 }]);
  await expectVerdict(built.buffer, 'allow');
});

// ---------- 复核场景 ----------

test('中央目录与本地记录名称不一致转复核', async () => {
  const built = buildZip([
    { name: 'alpha.txt', data: Buffer.from('aaaa') },
    { name: 'bravo.txt', data: Buffer.from('bbbb') },
  ]);
  const namePos = built.centralOffsets[0] + 46;
  built.buffer[namePos] = 0x41; // 'a' -> 'A'
  await expectVerdict(built.buffer, 'review');
});

test('多个中央条目共用同一本地记录转复核', async () => {
  const built = buildZip([
    { name: 'one.txt', data: Buffer.from('1111') },
    { name: 'two.txt', data: Buffer.from('2222') },
  ]);
  built.buffer.writeUInt32LE(built.localOffsets[0], built.centralOffsets[1] + 42);
  await expectVerdict(built.buffer, 'review');
});

test('CRC-32 与内容不符转复核', async () => {
  const built = buildZip([{ name: 'data.bin', data: Buffer.from('real content'), method: 8 }]);
  const wrongCrc = 0xdeadbeef;
  built.buffer.writeUInt32LE(wrongCrc, built.localOffsets[0] + 14);
  built.buffer.writeUInt32LE(wrongCrc, built.centralOffsets[0] + 16);
  await expectVerdict(built.buffer, 'review');
});

test('压缩数据夹带未消费的尾部字节转复核', async () => {
  const built = buildZip([
    { name: 'tail.bin', data: Buffer.from('some deflated content here'), method: 8, padCompressed: 6 },
  ]);
  await expectVerdict(built.buffer, 'review');
});

test('声明展开量很大、实际展开超过 128 MiB 即停止并转复核', async () => {
  const data = Buffer.alloc(129 * 1024 * 1024, 0x30);
  assert.strictEqual(data.length, 135266304);
  const built = buildZip([
    { name: 'bomb.bin', data, method: 8, declaredUncompressedSize: 0x10000000 },
  ]);
  const reason = await expectVerdict(built.buffer, 'review');
  assert.ok(reason.indexOf('128 MiB') >= 0, `unexpected reason: ${reason}`);
});

test('加密标志转复核', async () => {
  const built = buildZip([{ name: 'enc.txt', data: Buffer.from('secret') }]);
  built.buffer.writeUInt16LE(built.buffer.readUInt16LE(built.localOffsets[0] + 6) | 1, built.localOffsets[0] + 6);
  built.buffer.writeUInt16LE(built.buffer.readUInt16LE(built.centralOffsets[0] + 8) | 1, built.centralOffsets[0] + 8);
  await expectVerdict(built.buffer, 'review');
});

test('未设 UTF-8 标志的非 ASCII 名称转复核', async () => {
  const built = buildZip([{ name: '报表.txt', data: Buffer.from('x'), utf8: false }]);
  await expectVerdict(built.buffer, 'review');
});

test('不支持的压缩方式转复核', async () => {
  const built = buildZip([{ name: 'm.txt', data: Buffer.from('data') }]);
  built.buffer.writeUInt16LE(9, built.localOffsets[0] + 8);
  built.buffer.writeUInt16LE(9, built.centralOffsets[0] + 10);
  await expectVerdict(built.buffer, 'review');
});

test('ZIP64 标记转复核', async () => {
  const built = buildZip([{ name: 'z.txt', data: Buffer.from('z') }]);
  built.buffer.writeUInt16LE(0xffff, built.eocdOffset + 8);
  built.buffer.writeUInt16LE(0xffff, built.eocdOffset + 10);
  await expectVerdict(built.buffer, 'review');
});

test('分卷标记转复核', async () => {
  const built = buildZip([{ name: 'v.txt', data: Buffer.from('v') }]);
  built.buffer.writeUInt16LE(1, built.eocdOffset + 4);
  await expectVerdict(built.buffer, 'review');
});

test('Unicode Path 改名扩展转复核', async () => {
  const extra = Buffer.concat([Buffer.from([0x75, 0x70, 0x05, 0x00, 1, 2, 3, 4, 5])]);
  const built = buildZip([{ name: 'u.txt', data: Buffer.from('u'), extra }]);
  await expectVerdict(built.buffer, 'review');
});

test('额外字段边界不完整转复核', async () => {
  const extra = Buffer.from([0x09, 0x99, 0x08, 0x00, 1]);
  const built = buildZip([{ name: 'e.txt', data: Buffer.from('e'), extra }]);
  await expectVerdict(built.buffer, 'review');
});

test('前置与尾随无归属字节转复核', async () => {
  const built = buildZip([{ name: 'p.txt', data: Buffer.from('p') }]);
  await expectVerdict(Buffer.concat([Buffer.from('JUNK'), built.buffer]), 'review');
  await expectVerdict(Buffer.concat([built.buffer, Buffer.from('JUNK')]), 'review');
});

test('目录成员携带内容转复核', async () => {
  const built = buildZip([{ name: 'dir/', data: Buffer.from('not empty'), method: 0 }]);
  await expectVerdict(built.buffer, 'review');
});

// ---------- 隔离场景 ----------

test('伪装扩展名 report.pdf.EXE. 隔离', async () => {
  const built = buildZip([{ name: 'report.pdf.EXE. ', data: Buffer.from('MZ...'), method: 8 }]);
  await expectVerdict(built.buffer, 'quarantine');
});

test('反斜杠分隔与大小写混合的禁用扩展名隔离', async () => {
  const built = buildZip([
    { name: 'docs\\inner\\Payload.DlL', data: Buffer.from('x'), method: 0 },
    { name: 'clean/readme.txt', data: Buffer.from('y'), method: 0 },
  ]);
  await expectVerdict(built.buffer, 'quarantine');
});

test('结构异常优先于扩展名命中', async () => {
  const built = buildZip([{ name: 'evil.exe', data: Buffer.from('MZ'), method: 8 }]);
  const wrongCrc = 0x12345678;
  built.buffer.writeUInt32LE(wrongCrc, built.localOffsets[0] + 14);
  built.buffer.writeUInt32LE(wrongCrc, built.centralOffsets[0] + 16);
  await expectVerdict(built.buffer, 'review');
});

// ---------- 运行 ----------

async function main(): Promise<void> {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      process.stdout.write(`ok - ${t.name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`FAIL - ${t.name}\n`);
      const message = err instanceof Error && err.stack ? err.stack : String(err);
      process.stderr.write(`${message}\n`);
    }
  }
  rmSync(workDir, { recursive: true, force: true });
  process.stdout.write(`${tests.length - failed}/${tests.length} passed\n`);
  if (failed > 0) process.exit(1);
}

void main();
