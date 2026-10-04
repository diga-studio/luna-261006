import * as fs from "node:fs";
import * as path from "node:path";

/** 模型文件最大 100MB。 */
export const MAX_MODEL_BYTES = 100 * 1024 * 1024;

export const PIPELINE_FILE = "pipeline.json";
export const MODEL_FILE = "model.bin";

/** 生效记录：网关据此读取当前运行代次与整包位置。 */
export type ActiveRecord =
  | { state: "stopped"; generation: number }
  | { state: "running"; generation: number; releaseId: number; dir: string };

/**
 * 本地文件层。
 * 目录布局（baseDir 下）：
 *   releases/<id>/pipeline.json + model.bin   已提交的发布包（提交后不可变）
 *   staging/                                  发布中的临时目录，恢复时清理
 *   active.json(.tmp)                         生效记录，原子替换写入
 */
export class PackageStore {
  readonly baseDir: string;
  private readonly releasesDir: string;
  private readonly stagingDir: string;
  private readonly activePath: string;
  private readonly activeTmpPath: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.releasesDir = path.join(baseDir, "releases");
    this.stagingDir = path.join(baseDir, "staging");
    this.activePath = path.join(baseDir, "active.json");
    this.activeTmpPath = path.join(baseDir, "active.json.tmp");
    fs.mkdirSync(this.releasesDir, { recursive: true });
  }

  releaseDir(releaseId: number): string {
    return path.join(this.releasesDir, String(releaseId));
  }

  /** 校验源包并把文件复制进 staging，逐文件 fsync。返回模型字节数。 */
  stagePackage(sourceDir: string): { modelBytes: number } {
    const srcPipeline = path.join(sourceDir, PIPELINE_FILE);
    const srcModel = path.join(sourceDir, MODEL_FILE);
    const modelStat = fs.statSync(srcModel);
    if (!modelStat.isFile()) {
      throw new Error(`model file is not a regular file: ${srcModel}`);
    }
    if (modelStat.size > MAX_MODEL_BYTES) {
      throw new Error(`model file exceeds 100MB limit: ${modelStat.size} bytes`);
    }
    const pipelineStat = fs.statSync(srcPipeline);
    if (!pipelineStat.isFile()) {
      throw new Error(`pipeline file is not a regular file: ${srcPipeline}`);
    }

    this.cleanupStaging();
    fs.mkdirSync(this.stagingDir, { recursive: true });
    this.copyFileFsync(srcPipeline, path.join(this.stagingDir, PIPELINE_FILE));
    this.copyFileFsync(srcModel, path.join(this.stagingDir, MODEL_FILE));
    fsyncDir(this.stagingDir);
    fsyncDir(this.baseDir);
    return { modelBytes: modelStat.size };
  }

  /** 把 staging 目录改名为 releases/<id> 并 fsync 父目录。 */
  commitStaged(releaseId: number): string {
    const target = this.releaseDir(releaseId);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(this.stagingDir, target);
    fsyncDir(this.releasesDir);
    return target;
  }

  cleanupStaging(): void {
    fs.rmSync(this.stagingDir, { recursive: true, force: true });
  }

  removeReleaseDir(releaseId: number): void {
    fs.rmSync(this.releaseDir(releaseId), { recursive: true, force: true });
    fsyncDir(this.releasesDir);
  }

  listReleaseDirs(): number[] {
    return fs
      .readdirSync(this.releasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => Number(e.name))
      .sort((a, b) => a - b);
  }

  /** 发布包两个文件都存在且可读才算完整。 */
  isPackageComplete(releaseId: number): boolean {
    const dir = this.releaseDir(releaseId);
    try {
      fs.accessSync(path.join(dir, PIPELINE_FILE), fs.constants.R_OK);
      fs.accessSync(path.join(dir, MODEL_FILE), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  readActive(): ActiveRecord | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.activePath, "utf8");
    } catch {
      return null;
    }
    const parsed = JSON.parse(raw) as ActiveRecord;
    return parsed;
  }

  /** 原子写生效记录：写临时文件 + fsync + rename + fsync 目录。 */
  writeActive(record: ActiveRecord): void {
    fs.writeFileSync(this.activeTmpPath, JSON.stringify(record, null, 2));
    const fd = fs.openSync(this.activeTmpPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.activeTmpPath, this.activePath);
    fsyncDir(this.baseDir);
  }

  private copyFileFsync(src: string, dest: string): void {
    fs.copyFileSync(src, dest);
    const fd = fs.openSync(dest, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
