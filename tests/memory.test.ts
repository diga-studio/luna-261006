import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("no cumulative state across rounds; idle agents are dropped", () => {
  const check = fileURLToPath(new URL("./memory.check.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--expose-gc", check], {
    encoding: "utf8",
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.status, 0, "memory check failed");
});
