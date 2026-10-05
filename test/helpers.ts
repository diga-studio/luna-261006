import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StepSpec } from '../src/index.ts';

const NODE = process.execPath;

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ci-sched-'));
}

export function okStep(name: string, timeoutMs = 5000): StepSpec {
  return { name, command: NODE, args: ['-e', 'process.exit(0)'], timeoutMs };
}

export function failStep(name: string, timeoutMs = 5000): StepSpec {
  return { name, command: NODE, args: ['-e', 'process.exit(1)'], timeoutMs };
}

export function sleepStep(name: string, sleepMs: number, timeoutMs: number): StepSpec {
  return {
    name,
    command: NODE,
    args: ['-e', `setTimeout(() => process.exit(0), ${sleepMs})`],
    timeoutMs,
  };
}

/** Writes its marker file (with current time) then exits 0. */
export function markerStep(name: string, markerPath: string, timeoutMs = 5000): StepSpec {
  return {
    name,
    command: NODE,
    args: ['-e', 'require("node:fs").writeFileSync(process.env.MARKER, String(Date.now()))'],
    env: { MARKER: markerPath },
    timeoutMs,
  };
}

/**
 * Ignores SIGTERM; after `lingerMs` writes its exit timestamp to the marker
 * file and exits 0. Used to prove the pipeline waits for actual exit and
 * that late exit notifications cannot rewrite terminal states.
 */
export function stubbornStep(
  name: string,
  markerPath: string,
  lingerMs: number,
  timeoutMs: number,
): StepSpec {
  return {
    name,
    command: NODE,
    args: [
      '-e',
      'process.on("SIGTERM", () => {});' +
        `setTimeout(() => { require("node:fs").writeFileSync(process.env.MARKER, String(Date.now())); process.exit(0); }, ${lingerMs})`,
    ],
    env: { MARKER: markerPath },
    timeoutMs,
  };
}

export function markerExists(path: string): boolean {
  return existsSync(path);
}

export function markerTime(path: string): number {
  return Number(readFileSync(path, 'utf8'));
}

export function touch(path: string): void {
  writeFileSync(path, '1');
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
