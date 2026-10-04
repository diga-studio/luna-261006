import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/index';

let counter = 0;

export function freshDbPath(): string {
  counter += 1;
  return path.join(
    os.tmpdir(),
    `approval-test-${process.pid}-${Date.now()}-${counter}.sqlite`,
  );
}

export function freshDb(): { db: DatabaseSync; path: string } {
  const p = freshDbPath();
  return { db: openDatabase(p), path: p };
}

export function cleanup(p: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(p + suffix);
    } catch {
      /* ignore */
    }
  }
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const T0 = 1_700_000_000_000;
