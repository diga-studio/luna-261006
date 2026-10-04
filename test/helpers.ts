import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TelemetryBuffer } from "../src/index";
import type { ArchivedRecord } from "../src/index";

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readAll(buf: TelemetryBuffer, pageSize = 7): ArchivedRecord[] {
  const out: ArchivedRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = buf.read(cursor, pageSize);
    out.push(...page.records);
    if (page.records.length === 0 || page.nextCursor === cursor) {
      break;
    }
    cursor = page.nextCursor;
  }
  return out;
}

export function payloadOf(text: string): Buffer {
  return Buffer.from(text, "utf8");
}
