import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkZipFile } from '../src/index.ts';
import { buildZip } from './helpers/zipBuilder.ts';
import { writeTempZip, cleanupTempDirs } from './helpers/tmpFile.ts';

after(() => cleanupTempDirs());

const check = (buf: Buffer) => checkZipFile(writeTempZip(buf));

test('伪装扩展名 report.pdf.EXE. （尾部空格点号）→ 隔离', async () => {
  const buf = buildZip([{ name: 'report.pdf.EXE. ', content: Buffer.from('MZ...') }]);
  const r = await check(buf);
  assert.equal(r.verdict, 'quarantine');
  assert.deepEqual(r.bannedHits, [{ name: 'report.pdf.EXE. ', extension: '.exe' }]);
});

test('各类禁用扩展名（含反斜杠分隔、大小写混合）→ 隔离', async () => {
  const names = [
    'setup.exe',
    'EVIL.DLL',
    'a/b/c.scr',
    'dir\\run.bat',
    'x.Ps1',
    'install.com',
    'do.CMD',
  ];
  const buf = buildZip(names.map((name) => ({ name, content: Buffer.from('x') })));
  const r = await check(buf);
  assert.equal(r.verdict, 'quarantine');
  assert.equal(r.bannedHits.length, names.length);
});

test('禁用扩展名后还有真实扩展名 → 放行', async () => {
  const buf = buildZip([
    { name: 'notes.exe.txt', content: Buffer.from('x') },
    { name: 'archive.bat.pdf', content: Buffer.from('y') },
  ]);
  const r = await check(buf);
  assert.equal(r.verdict, 'allow');
});

test('结构异常优先于扩展名命中：CRC 错误的 evil.exe → 复核', async () => {
  const wrongCrc = 0xdeadbeef;
  const buf = buildZip([
    { name: 'evil.exe', content: Buffer.from('x'), cdCrc: wrongCrc, localCrc: wrongCrc },
  ]);
  const r = await check(buf);
  assert.equal(r.verdict, 'review');
});
