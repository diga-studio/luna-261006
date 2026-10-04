import * as fs from "node:fs";
import * as path from "node:path";

/** 生效记录内容：停止运行，或指向某个完整发布包。 */
export interface ActivePointer {
  generation: number;
  releaseId: number | null;
}

const POINTER_FILE = "active.json";
const POINTER_TMP = "active.json.tmp";
const RELEASES_DIR = "releases";
const STAGING_PREFIX = ".staging-";

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncTree(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fsyncTree(full);
    } else if (entry.isFile()) {
      const fd = fs.openSync(full, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
}

/** 本地包存储与生效记录（独立于 SQLite 的指针文件）。 */
export class PackageStore {
  private readonly dataDir: string;
  private readonly releasesDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.releasesDir = path.join(dataDir, RELEASES_DIR);
    fs.mkdirSync(this.releasesDir, { recursive: true });
  }

  /**
   * 把调用方输入目录完整复制到受管存储。
   * 先写入暂存目录并 fsync，再原子重命名为正式目录，保证任何时刻
   * 正式目录要么不存在、要么内容完整。
   */
  storePackage(sourceDir: string, releaseId: number): void {
    const staging = path.join(this.releasesDir, `${STAGING_PREFIX}${releaseId}`);
    const finalDir = this.packagePath(releaseId);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, staging, { recursive: true });
    fsyncTree(staging);
    fsyncDir(staging);
    fs.renameSync(staging, finalDir);
    fsyncDir(this.releasesDir);
  }

  packagePath(releaseId: number): string {
    return path.join(this.releasesDir, String(releaseId));
  }

  /** 原子切换生效记录：写临时文件、fsync、重命名、fsync 目录。 */
  switchPointer(pointer: ActivePointer): void {
    const tmp = path.join(this.dataDir, POINTER_TMP);
    const finalPath = path.join(this.dataDir, POINTER_FILE);
    fs.writeFileSync(tmp, JSON.stringify(pointer));
    const fd = fs.openSync(tmp, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, finalPath);
    fsyncDir(this.dataDir);
  }

  /** 读取生效记录；不存在时表示从未发布（停止运行、代次 0）。 */
  readPointer(): ActivePointer {
    const finalPath = path.join(this.dataDir, POINTER_FILE);
    if (!fs.existsSync(finalPath)) {
      return { generation: 0, releaseId: null };
    }
    const parsed = JSON.parse(fs.readFileSync(finalPath, "utf8")) as ActivePointer;
    return { generation: parsed.generation, releaseId: parsed.releaseId };
  }

  /** 清理崩溃可能留下的暂存目录与指针临时文件。 */
  cleanupStaging(): void {
    fs.rmSync(path.join(this.dataDir, POINTER_TMP), { force: true });
    for (const entry of fs.readdirSync(this.releasesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX)) {
        fs.rmSync(path.join(this.releasesDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  /** 移除没有对应发布记录的包目录（崩溃留下的半次发布）。 */
  pruneUnknown(validIds: ReadonlySet<number>): void {
    for (const entry of fs.readdirSync(this.releasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(STAGING_PREFIX)) {
        continue;
      }
      const id = Number(entry.name);
      if (!Number.isInteger(id) || !validIds.has(id)) {
        fs.rmSync(path.join(this.releasesDir, entry.name), { recursive: true, force: true });
      }
    }
  }
}
