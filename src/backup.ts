import * as fs from "fs";
import * as path from "path";

/**
 * 库文件快照工具：提交前整库复制，撤回时原子替换。
 * 只考虑进程终止（不考虑掉电），rename 的原子性足以保证
 * 恢复过程被打断后目标文件要么是旧版、要么是新版，不会是半写状态。
 */

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** 完整复制 src 到 dest：先写同目录临时文件并 fsync，再原子 rename */
function copyAtomic(src: string, dest: string, tmpTag: string): void {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(dest)}.${tmpTag}.tmp`);
  removeFileQuiet(tmp);
  fs.copyFileSync(src, tmp);
  const fd = fs.openSync(tmp, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  fsyncDir(dir);
}

/** 将 src 完整复制到 dest（快照落盘后才算完成） */
export function snapshotFile(src: string, dest: string): void {
  copyAtomic(src, dest, "snap");
}

/** 用快照文件原子覆盖目标库文件 */
export function restoreFile(snapshot: string, target: string): void {
  copyAtomic(snapshot, target, "restore");
}

/** 删除文件（不存在则忽略） */
export function removeFileQuiet(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
