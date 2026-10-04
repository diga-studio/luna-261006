import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { crc32 } from '../src/crc32.ts';
import { findBannedExtension } from '../src/nameRules.ts';

test('crc32 与 Node 内置 zlib.crc32 独立核对（含分段续算）', () => {
  for (let i = 0; i < 50; i++) {
    const data = randomBytes(1 + Math.floor(Math.random() * 4096));
    assert.equal(crc32(data), zlibCrc32(data) >>> 0);
    const cut = Math.floor(data.length / 2);
    const chunked = crc32(data.subarray(cut), crc32(data.subarray(0, cut)));
    assert.equal(chunked, zlibCrc32(data) >>> 0);
  }
});

test('findBannedExtension 规则核对', () => {
  const cases: [string, string | null][] = [
    ['report.pdf.EXE. ', '.exe'],
    ['a/b/c.DLL', '.dll'],
    ['dir\\sub\\x.Ps1', '.ps1'],
    ['plain.com', '.com'],
    ['x.scr  ', '.scr'],
    ['run.BAT.', '.bat'],
    ['do.CMD', '.cmd'],
    ['readme.txt', null],
    ['no-extension', null],
    ['file.exe.txt', null],
    ['trailing.', null],
    ['just.exe..  ..', '.exe'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(findBannedExtension(Buffer.from(input)), expected, JSON.stringify(input));
  }
});
