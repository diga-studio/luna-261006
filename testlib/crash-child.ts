import * as fs from "node:fs";
import * as path from "node:path";
import { TelemetryBuffer } from "../src/index.ts";

const dir = process.env.CRASH_DIR as string;
const mode = process.env.CRASH_MODE as string;
const count = Number(process.env.CRASH_COUNT);
const now = Number(process.env.CRASH_NOW);
const after = Number(process.env.CRASH_AFTER);

const tb = new TelemetryBuffer({
  dir,
  crashHooks: {
    afterRecordWrite: (index) => {
      if (mode === "partial" && index === after) {
        const fd = fs.openSync(path.join(dir, "archive.bin"), "a");
        fs.writeSync(fd, Buffer.from([0x47, 0x4c, 0x42, 0x54, 0x20, 0x00, 0x00]));
        fs.closeSync(fd);
        process.kill(process.pid, "SIGKILL");
      }
    },
    beforeStateCommit: () => {
      if (mode === "uncommitted") {
        process.kill(process.pid, "SIGKILL");
      }
    },
  },
});

for (let i = 0; i < count; i++) {
  tb.ingest(
    {
      deviceId: `dev-${i % 4}`,
      sampleAt: now - 60_000 + 1 + i,
      payload: Buffer.from(`payload-${i}`),
    },
    now,
  );
}
tb.advance(now + 60_000);
tb.close();
console.log("child finished normally");
