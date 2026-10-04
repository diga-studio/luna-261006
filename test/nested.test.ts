import * as fs from "node:fs";
import * as assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "./testutil";
import { makeEnv, writeFiles, leftoverTempFiles } from "./helpers";
import { submitBatch, readPlaintext, getProgress } from "../src/index";

test("valid ciphertext of batch A is ordinary plaintext for batch B", async () => {
  const env = makeEnv();
  try {
    const originals = [randomBytes(4096), Buffer.from("nested encryption test")];
    const files = writeFiles(env.filesDir, originals);
    const opts = { stateDir: env.stateDir };

    // Batch A encrypts the files.
    const pa = await submitBatch("batch-A", files, env.key, opts);
    assert.equal(pa.complete, true);
    const cipherA = files.map((f) => fs.readFileSync(f));

    // Batch B (different id, same key) must treat A's ciphertext as plaintext.
    const pb = await submitBatch("batch-B", files, env.key, opts);
    assert.equal(pb.complete, true);
    const cipherB = files.map((f) => fs.readFileSync(f));

    // B actually added a layer: output differs from A's ciphertext.
    for (let i = 0; i < files.length; i++) {
      assert.notDeepEqual(cipherB[i], cipherA[i]);
      assert.equal(cipherB[i].length, cipherA[i].length + 68);
    }

    // Reading back through B yields exactly A's ciphertext, byte-for-byte:
    // the input was NOT skipped and NOT decrypted an extra layer.
    for (let i = 0; i < files.length; i++) {
      const back = await readPlaintext("batch-B", files[i], env.key, opts);
      assert.deepEqual(back, cipherA[i], `file ${i}: B must return A's ciphertext`);
    }

    // Progress of both batches is consistent with the disk.
    assert.equal((await getProgress("batch-A", env.key, opts)).complete, true);
    assert.equal((await getProgress("batch-B", env.key, opts)).complete, true);
    assert.deepEqual(leftoverTempFiles(env.root), []);
  } finally {
    env.cleanup();
  }
});

test("resuming batch B does not add a third layer", async () => {
  const env = makeEnv();
  try {
    const files = writeFiles(env.filesDir, [randomBytes(1024)]);
    const opts = { stateDir: env.stateDir };
    await submitBatch("batch-A", files, env.key, opts);
    const cipherA = fs.readFileSync(files[0]);
    await submitBatch("batch-B", files, env.key, opts);
    const cipherB = fs.readFileSync(files[0]);

    // Resume B: must be a no-op on disk.
    await submitBatch("batch-B", files, env.key, opts);
    assert.deepEqual(fs.readFileSync(files[0]), cipherB);

    const back = await readPlaintext("batch-B", files[0], env.key, opts);
    assert.deepEqual(back, cipherA);
  } finally {
    env.cleanup();
  }
});
