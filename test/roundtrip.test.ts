import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "./testutil";
import { makeEnv, writeFiles, leftoverTempFiles } from "./helpers";
import {
  submitBatch,
  getProgress,
  readPlaintext,
  BatchConflictError,
  IntegrityError,
  ValidationError,
  VaultError,
} from "../src/index";

test("encrypts files in place and reads back exact original bytes", async () => {
  const env = makeEnv();
  try {
    const originals = [
      Buffer.alloc(0),
      Buffer.from("hello sentinel vault", "utf8"),
      randomBytes(100 * 1024),
      Buffer.from([0, 1, 2, 255, 254, 253]),
    ];
    const files = writeFiles(env.filesDir, originals);

    const progress = await submitBatch("batch-1", files, env.key, {
      stateDir: env.stateDir,
    });
    assert.equal(progress.complete, true);
    assert.equal(progress.completed, 4);
    assert.equal(progress.total, 4);

    // Ciphertext differs from plaintext and files still exist at same paths.
    for (let i = 0; i < files.length; i++) {
      const onDisk = fs.readFileSync(files[i]);
      assert.notDeepEqual(onDisk, originals[i]);
      assert.ok(onDisk.length === originals[i].length + 68);
    }

    for (let i = 0; i < files.length; i++) {
      const back = await readPlaintext("batch-1", files[i], env.key, {
        stateDir: env.stateDir,
      });
      assert.deepEqual(back, originals[i], `file ${i} roundtrip`);
    }

    const queried = await getProgress("batch-1", env.key, {
      stateDir: env.stateDir,
    });
    assert.equal(queried.complete, true);
    assert.deepEqual(leftoverTempFiles(env.root), []);
  } finally {
    env.cleanup();
  }
});

test("resubmitting a finished batch leaves ciphertext untouched", async () => {
  const env = makeEnv();
  try {
    const originals = [randomBytes(1024), randomBytes(2048)];
    const files = writeFiles(env.filesDir, originals);
    await submitBatch("batch-2", files, env.key, { stateDir: env.stateDir });
    const before = files.map((f) => fs.readFileSync(f));

    const again = await submitBatch("batch-2", files, env.key, {
      stateDir: env.stateDir,
    });
    assert.equal(again.complete, true);
    const after = files.map((f) => fs.readFileSync(f));
    for (let i = 0; i < files.length; i++) {
      assert.deepEqual(after[i], before[i], `file ${i} must be byte-identical`);
    }
  } finally {
    env.cleanup();
  }
});

test("rejects invalid input", async () => {
  const env = makeEnv();
  try {
    const files = writeFiles(env.filesDir, [Buffer.from("x")]);
    const opts = { stateDir: env.stateDir };

    await assert.rejects(
      submitBatch("b", files, randomBytes(16), opts),
      (e) => e instanceof ValidationError
    );
    await assert.rejects(
      submitBatch("b", ["relative/path.txt"], env.key, opts),
      (e) => e instanceof ValidationError
    );
    await assert.rejects(
      submitBatch("b", [...files, ...files], env.key, opts),
      (e) => e instanceof ValidationError
    );
    await assert.rejects(
      submitBatch("b", [path.join(env.filesDir, "missing.bin")], env.key, opts),
      (e) => e instanceof ValidationError
    );
    await assert.rejects(
      submitBatch("b", [], env.key, opts),
      (e) => e instanceof ValidationError
    );
    const tooMany = Array.from({ length: 501 }, (_, i) => `/tmp/f-${i}`);
    await assert.rejects(
      submitBatch("b", tooMany, env.key, opts),
      (e) => e instanceof ValidationError
    );
  } finally {
    env.cleanup();
  }
});

test("rejects retry with different key or manifest", async () => {
  const env = makeEnv();
  try {
    const files = writeFiles(env.filesDir, [Buffer.from("data")]);
    const opts = { stateDir: env.stateDir };
    await submitBatch("batch-3", files, env.key, opts);

    await assert.rejects(
      submitBatch("batch-3", files, randomBytes(32), opts),
      (e) => e instanceof BatchConflictError
    );
    const other = writeFiles(env.filesDir, [Buffer.from("y"), Buffer.from("z")]);
    await assert.rejects(
      submitBatch("batch-3", other, env.key, opts),
      (e) => e instanceof BatchConflictError
    );
    await assert.rejects(
      getProgress("batch-3", randomBytes(32), opts),
      (e) => e instanceof BatchConflictError
    );
  } finally {
    env.cleanup();
  }
});

test("integrity failure returns no plaintext", async () => {
  const env = makeEnv();
  try {
    const files = writeFiles(env.filesDir, [randomBytes(4096)]);
    const opts = { stateDir: env.stateDir };
    await submitBatch("batch-4", files, env.key, opts);

    const corrupted = fs.readFileSync(files[0]);
    corrupted[corrupted.length - 20] ^= 0xff;
    fs.writeFileSync(files[0], corrupted);

    await assert.rejects(
      readPlaintext("batch-4", files[0], env.key, opts),
      (e) => e instanceof IntegrityError
    );
  } finally {
    env.cleanup();
  }
});

test("unknown batch and foreign file are rejected", async () => {
  const env = makeEnv();
  try {
    const files = writeFiles(env.filesDir, [Buffer.from("a"), Buffer.from("b")]);
    const opts = { stateDir: env.stateDir };
    await submitBatch("batch-5", [files[0]], env.key, opts);

    await assert.rejects(
      getProgress("nope", env.key, opts),
      (e) => e instanceof VaultError && e.code === "UNKNOWN_BATCH"
    );
    await assert.rejects(
      readPlaintext("batch-5", files[1], env.key, opts),
      (e) => e instanceof ValidationError
    );
  } finally {
    env.cleanup();
  }
});
