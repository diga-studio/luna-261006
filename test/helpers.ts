import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

export function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "splitcart-"));
  dirs.push(dir);
  return join(dir, "plan.db");
}

export function cleanupAll(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
