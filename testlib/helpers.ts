import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function payloadOf(text: string): Buffer {
  return Buffer.from(text, "utf8");
}
