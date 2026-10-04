import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface TestEnv {
  root: string;
  stateDir: string;
  filesDir: string;
  key: Buffer;
  cleanup(): void;
}

export function makeEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "svlt-test-"));
  return {
    root,
    stateDir: path.join(root, "state"),
    filesDir: path.join(root, "files"),
    key: randomBytes(32),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function writeFiles(dir: string, contents: Buffer[]): string[] {
  fs.mkdirSync(dir, { recursive: true });
  return contents.map((data, i) => {
    const p = path.join(dir, `file-${i}.bin`);
    fs.writeFileSync(p, data);
    return p;
  });
}

export interface WorkerResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Run submitBatch in a child process. If crashPoint is set, the child is
 * SIGKILLed on the `crashAfterN`-th invocation of that crash point.
 */
export function runWorker(args: {
  stateDir: string;
  batchId: string;
  key: Buffer;
  files: string[];
  crashPoint?: string;
  crashAfterN?: number;
}): WorkerResult {
  const workerPath = path.join(__dirname, "worker.js");
  const res = spawnSync(
    process.execPath,
    [
      workerPath,
      args.stateDir,
      args.batchId,
      args.key.toString("hex"),
      args.crashPoint ?? "",
      String(args.crashAfterN ?? 1),
      ...args.files,
    ],
    { encoding: "utf8" }
  );
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/** List leftover temp files anywhere under `dir`. */
export function leftoverTempFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.includes(".svlt-")) found.push(p);
    }
  };
  walk(dir);
  return found;
}
