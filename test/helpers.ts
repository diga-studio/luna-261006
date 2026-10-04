import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SourcePackageSpec {
  /** 流水线 JSON 内容（对象会被序列化）。 */
  pipeline: unknown;
  /** 模型文件字节长度。 */
  modelBytes: number;
  /** 模型内容填充种子，保证不同包内容不同且可逐字节复现。 */
  seed: number;
}

export function makeWorkDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 生成确定性的模型字节内容。 */
export function modelContent(spec: SourcePackageSpec): Buffer {
  const buf = Buffer.alloc(spec.modelBytes);
  let x = spec.seed || 1;
  for (let i = 0; i < buf.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = x & 0xff;
  }
  return buf;
}

/** 在 dir 下生成一个源发布包（pipeline.json + model.bin）。 */
export function makeSourcePackage(dir: string, spec: SourcePackageSpec): void {
  fs.mkdirSync(dir, { recursive: true });
  const pipeline =
    typeof spec.pipeline === "string" ? spec.pipeline : JSON.stringify(spec.pipeline, null, 2);
  fs.writeFileSync(path.join(dir, "pipeline.json"), pipeline);
  fs.writeFileSync(path.join(dir, "model.bin"), modelContent(spec));
}

/** 逐字节比较两个目录下的发布包文件。 */
export function packagesByteEqual(dirA: string, dirB: string): boolean {
  for (const name of ["pipeline.json", "model.bin"]) {
    const a = fs.readFileSync(path.join(dirA, name));
    const b = fs.readFileSync(path.join(dirB, name));
    if (!a.equals(b)) return false;
  }
  return true;
}

export function readActiveRecord(workDir: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(workDir, "active.json"), "utf8"));
}

export type WorkerOp =
  | { type: "publish"; requestId: string; sourceDir: string }
  | { type: "report"; requestId: string; report: { generation: number; timestampMs: number; success: boolean } };

export interface WorkerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const WORKER_PATH = path.join(__dirname, "crash-worker.js");

/** 在子进程中执行一串操作；crashAt 非空时子进程在该持久化边界直接退出。 */
export function runWorker(workDir: string, ops: WorkerOp[], crashAt: string): WorkerResult {
  const res = spawnSync(process.execPath, [WORKER_PATH], {
    env: {
      ...process.env,
      WORK_DIR: workDir,
      OPS_JSON: JSON.stringify(ops),
      CRASH_AT: crashAt,
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
