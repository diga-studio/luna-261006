import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { HrImporter } from "../src/index.js";
import { generateCsv, runToCompletion, snapshot } from "./helpers.js";

const CHILD = fileURLToPath(
  new URL("./fixtures/child.js", import.meta.url),
);

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hr-crash-"));
}

const CRASH_OPTS = {
  records: 1000,
  multilineEvery: 6,
  badEvery: 9,
  dupEvery: 4,
  quotedEvery: 12,
  bom: true,
  crlf: true,
  trailingNewline: false,
};

interface ChildResult {
  committedOffset: number;
}

function readCommittedOffset(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT read_offset FROM tasks WHERE id = 1").get() as {
      read_offset: number;
    };
    return Number(row.read_offset);
  } finally {
    db.close();
  }
}

async function runCrashingChild(
  dbPath: string,
  csvPath: string,
  mode: string,
  normalAdvances: number,
): Promise<void> {
  const child = spawn(
    process.execPath,
    [CHILD, dbPath, csvPath, mode, String(normalAdvances)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child did not reach pause point in time"));
    }, 30000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("PAUSED")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}

async function crashAndResume(mode: string): Promise<void> {
  const dir = tmpdir();
  const csvPath = path.join(dir, "cases.csv");
  fs.writeFileSync(csvPath, generateCsv(CRASH_OPTS), "utf8");

  const refImporter = new HrImporter(path.join(dir, "ref.sqlite"));
  const refId = refImporter.createImport(csvPath);
  runToCompletion(refImporter, refId);
  const ref = snapshot(refImporter, refId);
  refImporter.close();

  const dbPath = path.join(dir, "crash.sqlite");
  await runCrashingChild(dbPath, csvPath, mode, 2);

  const committedOffset = readCommittedOffset(dbPath);
  assert.ok(committedOffset > 0, "some prefix must be committed before crash");

  const reads: { offset: number; length: number }[] = [];
  const importer = new HrImporter(dbPath, {
    hooks: { onRead: (offset, length) => reads.push({ offset, length }) },
  });
  const id = 1;
  runToCompletion(importer, id);
  const extra = importer.advanceImport(id);
  assert.equal(extra.done, true);
  assert.equal(extra.processed, 0);
  const got = snapshot(importer, id);
  importer.close();

  assert.deepEqual(got, ref);

  assert.ok(reads.length > 0, "resume must read from source file");
  for (const r of reads) {
    assert.ok(
      r.offset >= committedOffset,
      `read at ${r.offset} rescans committed prefix ending at ${committedOffset}`,
    );
  }
}

test("kill before commit: resume matches uninterrupted import", async () => {
  await crashAndResume("hang-before-commit");
});

test("kill after commit before return: resume matches uninterrupted import", async () => {
  await crashAndResume("hang-after-commit");
});

test("deep file resume never rereads committed prefix", async () => {
  const dir = tmpdir();
  const csvPath = path.join(dir, "big.csv");
  fs.writeFileSync(
    csvPath,
    generateCsv({ records: 20000, multilineEvery: 50, badEvery: 37 }),
    "utf8",
  );
  const dbPath = path.join(dir, "big.sqlite");

  const importer1 = new HrImporter(dbPath);
  const id = importer1.createImport(csvPath);
  for (let i = 0; i < 60; i++) importer1.advanceImport(id);
  importer1.close();

  const committedOffset = readCommittedOffset(dbPath);
  const fileSize = fs.statSync(csvPath).size;
  assert.ok(
    committedOffset > fileSize / 4,
    `committed offset ${committedOffset} should be well inside file of ${fileSize}`,
  );

  const reads: { offset: number; length: number }[] = [];
  const importer2 = new HrImporter(dbPath, {
    hooks: { onRead: (offset, length) => reads.push({ offset, length }) },
  });
  const r = importer2.advanceImport(id);
  assert.equal(r.processed, 128);
  importer2.close();

  assert.ok(reads.length > 0);
  const minRead = Math.min(...reads.map((x) => x.offset));
  assert.equal(minRead, committedOffset);
  const maxChunk = Math.max(...reads.map((x) => x.length));
  assert.ok(
    maxChunk >= 64 * 1024,
    "reads use 64 KiB chunks that span many logical records (cross-record readahead)",
  );
});
