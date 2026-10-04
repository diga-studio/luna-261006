import * as fs from "node:fs";
import { TelemetryBuffer } from "../src/index";
import type { AdvanceHooks } from "../src/index";

// Child process used by crash.test.ts. It ingests `count` events and starts an
// advance() that is guaranteed to stop at a controllable pause point, then the
// parent kills it with SIGKILL. It must never exit cleanly on the crash paths.

const [dir, scenario, tag, countStr, baseNowStr] = process.argv.slice(2);
const count = Number(countStr);
const baseNow = Number(baseNowStr);

function pauseForever(): void {
  fs.writeSync(1, "READY\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

let hooks: AdvanceHooks;
if (scenario === "partial") {
  hooks = { onPartialWrite: pauseForever };
} else if (scenario === "flushed") {
  hooks = { afterFsyncBeforeCommit: pauseForever };
} else {
  hooks = {};
}

const buf = new TelemetryBuffer({ dir, hooks });
for (let i = 0; i < count; i += 1) {
  buf.ingest(
    {
      deviceId: `child-${tag}-${i}`,
      sampleAt: baseNow + i,
      payload: Buffer.from(`payload-${tag}-${i}`, "utf8"),
    },
    baseNow + i,
  );
}
buf.advance(baseNow + 120_000);
fs.writeSync(1, "DONE\n");
buf.close();
