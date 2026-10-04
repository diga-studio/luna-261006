// 崩溃测试用子进程：对指定任务执行一次 advanceImport。
// 通过 HR_IMPORT_PAUSE_* 环境变量在暂停点阻塞，等待父进程 SIGKILL。
import { createImporter } from "../src/index.js";

const [dbPath, taskId] = process.argv.slice(2);
if (!dbPath || !taskId) {
  console.error("usage: child.js <dbPath> <taskId>");
  process.exit(2);
}
const imp = createImporter(dbPath);
const res = imp.advanceImport(Number(taskId));
imp.close();
process.stdout.write(JSON.stringify(res) + "\n");
