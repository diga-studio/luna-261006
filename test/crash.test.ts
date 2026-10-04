import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "./testutil";
import { makeEnv, writeFiles, runWorker, leftoverTempFiles } from "./helpers";
import { submitBatch, getProgress, readPlaintext } from "../src/index";
import { TaskStore } from "../src/store";

function readAll(files: string[]): Buffer[] {
  return files.map((f) => fs.readFileSync(f));
}

async function assertAllReadable(
  batchId: string,
  files: string[],
  originals: Buffer[],
  stateDir: string,
  key: Buffer
): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    const back = await readPlaintext(batchId, files[i], key, { stateDir });
    assert.deepEqual(back, originals[i], `file ${i} must read back original bytes`);
  }
}

test("crash in the middle of temp write: resume completes, no residue", async () => {
  const env = makeEnv();
  try {
    // 1.5 MiB forces a multi-chunk temp write; crash after the first chunk.
    const originals = [randomBytes(1.5 * 1024 * 1024), randomBytes(3000)];
    const files = writeFiles(env.filesDir, originals);

    const crashed = runWorker({
      stateDir: env.stateDir,
      batchId: "crash-mid-write",
      key: env.key,
      files,
      crashPoint: "temp-write-chunk",
      crashAfterN: 1,
    });
    assert.equal(crashed.signal, "SIGKILL");

    // A truncated temp file remains; every target is still intact plaintext.
    const temps = leftoverTempFiles(env.filesDir);
    assert.equal(temps.length, 1);
    assert.equal(fs.statSync(temps[0]).size, 1024 * 1024);
    assert.deepEqual(readAll(files), originals);

    const progress = await submitBatch("crash-mid-write", files, env.key, {
      stateDir: env.stateDir,
    });
    assert.equal(progress.complete, true);
    await assertAllReadable("crash-mid-write", files, originals, env.stateDir, env.key);
    assert.deepEqual(leftoverTempFiles(env.root), []);
  } finally {
    env.cleanup();
  }
});

test("crash after rename but before record: ciphertext untouched, progress reconciled", async () => {
  const env = makeEnv();
  try {
    const originals = [randomBytes(5000), randomBytes(6000), randomBytes(7000)];
    const files = writeFiles(env.filesDir, originals);

    const crashed = runWorker({
      stateDir: env.stateDir,
      batchId: "crash-after-rename",
      key: env.key,
      files,
      crashPoint: "after-rename",
      crashAfterN: 1,
    });
    assert.equal(crashed.signal, "SIGKILL");

    // File 0 is already final ciphertext, but its record was never persisted.
    const finalBytes = fs.readFileSync(files[0]);
    assert.notDeepEqual(finalBytes, originals[0]);
    const store = new TaskStore(
      path.join(env.stateDir, "sentinelvault-tasks.sqlite")
    );
    const records = store.listFiles("crash-after-rename");
    store.close();
    assert.deepEqual(
      records.map((r) => r.done),
      [false, false, false],
      "no completion record may exist yet"
    );

    // Progress must reflect the disk, not the stale record.
    const mid = await getProgress("crash-after-rename", env.key, {
      stateDir: env.stateDir,
    });
    assert.deepEqual(
      mid.files.map((f) => f.done),
      [true, false, false]
    );

    const done = await submitBatch("crash-after-rename", files, env.key, {
      stateDir: env.stateDir,
    });
    assert.equal(done.complete, true);

    // The pre-crash ciphertext survived the resume byte-for-byte.
    assert.deepEqual(fs.readFileSync(files[0]), finalBytes);
    await assertAllReadable("crash-after-rename", files, originals, env.stateDir, env.key);
    assert.deepEqual(leftoverTempFiles(env.root), []);
  } finally {
    env.cleanup();
  }
});

test("crash again during recovery: a second resume still finishes", async () => {
  const env = makeEnv();
  try {
    const originals = [randomBytes(2000), randomBytes(2000), randomBytes(2000)];
    const files = writeFiles(env.filesDir, originals);

    // First run dies right after renaming file 0.
    const first = runWorker({
      stateDir: env.stateDir,
      batchId: "crash-twice",
      key: env.key,
      files,
      crashPoint: "after-rename",
      crashAfterN: 1,
    });
    assert.equal(first.signal, "SIGKILL");
    const finalBytes0 = fs.readFileSync(files[0]);

    // The recovery run dies again, now while starting file 1's temp write.
    const second = runWorker({
      stateDir: env.stateDir,
      batchId: "crash-twice",
      key: env.key,
      files,
      crashPoint: "temp-write-started",
      crashAfterN: 1,
    });
    assert.equal(second.signal, "SIGKILL");
    assert.deepEqual(fs.readFileSync(files[0]), finalBytes0);

    // A clean resume finishes the batch.
    const done = await submitBatch("crash-twice", files, env.key, {
      stateDir: env.stateDir,
    });
    assert.equal(done.complete, true);
    assert.deepEqual(fs.readFileSync(files[0]), finalBytes0);
    await assertAllReadable("crash-twice", files, originals, env.stateDir, env.key);
    assert.deepEqual(leftoverTempFiles(env.root), []);
  } finally {
    env.cleanup();
  }
});

test("worker without crash point completes the whole batch", async () => {
  const env = makeEnv();
  try {
    const originals = [randomBytes(100), randomBytes(200)];
    const files = writeFiles(env.filesDir, originals);
    const res = runWorker({
      stateDir: env.stateDir,
      batchId: "worker-clean",
      key: env.key,
      files,
    });
    assert.equal(res.status, 0, res.stderr);
    const progress = JSON.parse(res.stdout);
    assert.equal(progress.complete, true);
    await assertAllReadable("worker-clean", files, originals, env.stateDir, env.key);
  } finally {
    env.cleanup();
  }
});
