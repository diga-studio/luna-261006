import { GatewayManager } from "../src/index";

/**
 * 崩溃注入子进程：按 OPS_JSON 执行操作。
 * CRASH_AT 格式为 "point" 或 "point@N"：第 N 次（默认第 1 次）命中该
 * 持久化边界钩子时直接 process.exit，模拟进程突然退出。
 */
async function main(): Promise<void> {
  const workDir = process.env.WORK_DIR;
  const ops = JSON.parse(process.env.OPS_JSON ?? "[]") as Array<
    | { type: "publish"; requestId: string; sourceDir: string }
    | { type: "report"; requestId: string; report: { generation: number; timestampMs: number; success: boolean } }
  >;
  const crashAt = process.env.CRASH_AT ?? "";
  if (!workDir) throw new Error("WORK_DIR is required");

  const [crashPoint, crashCountStr] = crashAt.split("@");
  const crashCount = crashCountStr ? Number.parseInt(crashCountStr, 10) : 1;
  let seen = 0;

  const manager = await GatewayManager.open(workDir, {
    crashHook: (point) => {
      if (crashPoint && point === crashPoint) {
        seen += 1;
        if (seen === crashCount) {
          process.exit(43);
        }
      }
    },
  });

  for (const op of ops) {
    if (op.type === "publish") {
      const r = await manager.publish(op.requestId, op.sourceDir);
      console.log("publish", JSON.stringify(r));
    } else {
      const r = await manager.reportInference(op.requestId, op.report);
      console.log("report", JSON.stringify(r));
    }
  }
  manager.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
