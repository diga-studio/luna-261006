/**
 * Child-process worker: runs submitBatch and optionally kills itself with
 * SIGKILL on the Nth invocation of a given crash point, simulating an
 * abrupt process termination (no cleanup, no handlers).
 */
import { submitBatch } from "../src/index";
import { CrashPoint } from "../src/types";

async function main(): Promise<void> {
  const [, , stateDir, batchId, keyHex, crashPoint, crashAfterN, ...files] =
    process.argv;
  const key = Buffer.from(keyHex, "hex");
  const killAt = crashPoint === "" ? null : (crashPoint as CrashPoint);
  const n = Number(crashAfterN);
  let count = 0;

  const progress = await submitBatch(batchId, files, key, {
    stateDir,
    crashHook: killAt
      ? (point) => {
          if (point === killAt) {
            count += 1;
            if (count >= n) {
              process.kill(process.pid, "SIGKILL");
            }
          }
        }
      : undefined,
  });
  process.stdout.write(JSON.stringify(progress));
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
