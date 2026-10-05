import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RenderQueue } from "../src/index";

export class FakeClock {
  private current: number;
  constructor(start: number) {
    this.current = start;
  }
  now = (): number => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
}

export interface TestContext {
  dir: string;
  clock: FakeClock;
  queue: RenderQueue;
  writeSource(name: string, bytes: number[]): string;
  cleanup(): void;
}

export function makeContext(start = 1_000_000): TestContext {
  const dir = mkdtempSync(join(tmpdir(), "render-queue-test-"));
  const clock = new FakeClock(start);
  const queue = new RenderQueue({ dataDir: dir, now: clock.now });
  return {
    dir,
    clock,
    queue,
    writeSource(name: string, bytes: number[]): string {
      const path = join(dir, name);
      writeFileSync(path, Buffer.from(bytes));
      return path;
    },
    cleanup(): void {
      queue.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
