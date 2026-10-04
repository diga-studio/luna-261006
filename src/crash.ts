/**
 * 崩溃注入点：仅用于自动化测试模拟进程在持久化边界突然退出。
 * 通过环境变量 EDGEFORGE_CRASH_AT 指定注入点名称，命中时立即退出进程。
 */
export type CrashPoint = "publish.afterPackageStore" | "publish.afterDbCommit" | "publish.afterPointerSwitch" | "rollback.afterDbCommit" | "rollback.afterPointerSwitch";

export function crashIfRequested(point: CrashPoint): void {
  if (process.env.EDGEFORGE_CRASH_AT === point) {
    process.exit(1);
  }
}
