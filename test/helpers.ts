import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Fixture {
  dir: string;
  dbPath: string;
  key: Buffer;
  files: string[];
  contents: Map<string, Buffer>;
}

/** 构造一个批次的工作目录：若干随机/边界内容的文件。 */
export function makeFixture(fileCount: number): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'svlt-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  const key = randomBytes(32);
  const files: string[] = [];
  const contents = new Map<string, Buffer>();
  for (let i = 0; i < fileCount; i++) {
    const path = join(dataDir, `file-${i}.bin`);
    let data: Buffer;
    if (i === 0) {
      data = Buffer.alloc(0); // 空文件
    } else if (i === 1) {
      data = Buffer.from([0x53, 0x56, 0x4c, 0x54, 0x01, 0xff, 0x00]); // 恰好以魔数开头的普通原文
    } else {
      data = randomBytes(1024 + i * 977);
    }
    writeFileSync(path, data);
    files.push(path);
    contents.set(path, data);
  }
  return { dir, dbPath: join(dir, 'vault.db'), key, files, contents };
}

export function tempFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.svltmp-')) out.push(join(dir, name));
  }
  return out;
}

/** 模拟进程崩溃的异常。 */
export class SimulatedCrash extends Error {
  constructor() {
    super('simulated process crash');
    this.name = 'SimulatedCrash';
  }
}
