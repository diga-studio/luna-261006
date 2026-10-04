import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 构造一个发布包源目录：pipeline.json + model.bin。 */
export function makePackage(tag: string, modelSize: number): string {
  const dir = freshDir("edgeforge-src-");
  fs.writeFileSync(path.join(dir, "pipeline.json"), JSON.stringify({ pipeline: tag, version: 1 }));
  const model = Buffer.alloc(modelSize);
  for (let i = 0; i < model.length; i += 1) {
    model[i] = (tag.charCodeAt(0) + i) % 251;
  }
  fs.writeFileSync(path.join(dir, "model.bin"), model);
  return dir;
}

function listFiles(root: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(path.join(root, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

/** 逐字节比较两个目录树。 */
export function assertDirsEqual(actual: string, expected: string): void {
  const actualFiles = listFiles(actual);
  const expectedFiles = listFiles(expected);
  assert.deepEqual(actualFiles, expectedFiles);
  for (const rel of actualFiles) {
    const a = fs.readFileSync(path.join(actual, rel));
    const b = fs.readFileSync(path.join(expected, rel));
    assert.ok(a.equals(b), `file content mismatch: ${rel}`);
  }
}

export function readPointer(dataDir: string): { generation: number; releaseId: number | null } {
  const file = path.join(dataDir, "active.json");
  if (!fs.existsSync(file)) {
    return { generation: 0, releaseId: null };
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const DRIVER = path.join(__dirname, "fixtures", "driver.js");

/** 在子进程中执行驱动命令；返回退出码与 stdout（正常退出时解析为 JSON）。 */
export function runDriver(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [DRIVER, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (err) {
    const failed = err as { status: number; stdout: string };
    return { code: failed.status, stdout: failed.stdout ?? "" };
  }
}
