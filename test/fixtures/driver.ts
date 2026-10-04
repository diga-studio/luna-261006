import { GatewayManager } from "../../src/manager";

/**
 * 崩溃测试驱动：在子进程中执行单个操作。
 * 用法: node driver.js <dataDir> <command> [args...]
 * 通过环境变量 EDGEFORGE_CRASH_AT 注入崩溃点。
 */
function main(): void {
  const [dataDir, command, ...rest] = process.argv.slice(2);
  const manager = new GatewayManager(dataDir);
  let result: unknown;
  switch (command) {
    case "publish":
      result = manager.publish({ requestId: rest[0], sourceDir: rest[1] });
      break;
    case "report":
      result = manager.reportInference({
        requestId: rest[0],
        generation: Number(rest[1]),
        timestamp: Number(rest[2]),
        success: rest[3] === "success",
      });
      break;
    case "recover":
      result = manager.recover();
      break;
    case "status":
      result = manager.getStatus();
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
  process.stdout.write(JSON.stringify(result));
  manager.close();
}

main();
