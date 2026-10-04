import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

export function writeTempZip(buf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'zipcheck-'));
  dirs.push(dir);
  const file = join(dir, 'sample.zip');
  writeFileSync(file, buf);
  return file;
}

export function cleanupTempDirs(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
