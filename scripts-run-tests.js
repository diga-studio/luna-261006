// 跨平台测试启动器：为测试进程设置受控的 V8 堆上限，
// 使大规模测试的峰值 RSS 可稳定落在 512 MiB 限制内。
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const res = spawnSync(process.execPath, ["--test", "dist/test/*.test.js"], {
  cwd: path.join(__dirname),
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: "--max-old-space-size=320 --max-semi-space-size=8",
  },
});
process.exit(res.status === null ? 1 : res.status);
