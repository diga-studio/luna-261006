/**
 * Core library: crash-safe in-place file encryption with SQLite task records.
 *
 * Per-file protocol (serial, one file at a time):
 *   1. remove any stale temp file of this batch for the target
 *   2. if the target already holds this batch's final container -> reconcile
 *      the task record and skip without touching a single byte
 *   3. otherwise read the plaintext, encrypt into a temp file in the same
 *      directory (fsync), atomically rename over the target, fsync the
 *      directory, then persist the completion record
 *
 * A crash at any instant leaves the target either as the complete original
 * plaintext or as the complete final ciphertext; a leftover temp file is
 * harmless and removed on the next run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { BatchCrypto, createBatchCrypto, HEADER_LENGTH } from "./crypto";
import { BatchConflictError, ValidationError, VaultError } from "./errors";
import { TaskStore } from "./store";
import { BatchProgress, CrashPoint, VaultOptions } from "./types";

const MAX_FILES = 500;
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const WRITE_CHUNK = 1024 * 1024;

interface Context {
  batchId: string;
  key: Buffer;
  crypto: BatchCrypto;
  store: TaskStore;
  crashHook?: (point: CrashPoint, filePath: string) => void;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function manifestHash(paths: string[]): string {
  const hash = createHash("sha256");
  for (const p of paths) {
    hash.update(Buffer.from(p, "utf8"));
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

function validateKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new ValidationError("key must be a 32-byte Buffer");
  }
}

function validateManifest(batchId: string, files: string[]): void {
  if (typeof batchId !== "string" || batchId.length === 0) {
    throw new ValidationError("batchId must be a non-empty string");
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    throw new ValidationError(`manifest must contain 1..${MAX_FILES} files`);
  }
  const seen = new Set<string>();
  for (const p of files) {
    if (typeof p !== "string" || !path.isAbsolute(p)) {
      throw new ValidationError(`path must be absolute: ${String(p)}`);
    }
    if (seen.has(p)) {
      throw new ValidationError(`duplicate path in manifest: ${p}`);
    }
    seen.add(p);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(p);
    } catch {
      throw new ValidationError(`file not found: ${p}`);
    }
    if (!stat.isFile()) {
      throw new ValidationError(`not a regular file: ${p}`);
    }
  }
}

function tempPathOf(crypto: BatchCrypto, filePath: string): string {
  return `${filePath}.svlt-${crypto.batchTag.toString("hex")}.tmp`;
}

function readHeader(filePath: string): Buffer | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEADER_LENGTH);
    const read = fs.readSync(fd, buf, 0, HEADER_LENGTH, 0);
    return read < HEADER_LENGTH ? buf.subarray(0, read) : buf;
  } finally {
    fs.closeSync(fd);
  }
}

function isFinalOnDisk(ctx: Context, filePath: string): boolean {
  const header = readHeader(filePath);
  return header !== null && ctx.crypto.isFinalContainer(filePath, header);
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Write `data` to `tempPath` in chunks, fsync, close. Crash points included. */
function writeTempFile(ctx: Context, tempPath: string, filePath: string, data: Buffer): void {
  const hook = ctx.crashHook;
  const fd = fs.openSync(tempPath, "w");
  try {
    hook?.("temp-write-started", filePath);
    let offset = 0;
    while (offset < data.length) {
      const end = Math.min(offset + WRITE_CHUNK, data.length);
      fs.writeSync(fd, data, offset, end - offset);
      offset = end;
      hook?.("temp-write-chunk", filePath);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  hook?.("temp-write-finished", filePath);
}

/** Encrypt one pending file in place; persist its completion record. */
function processFile(ctx: Context, filePath: string): void {
  const plaintext = fs.readFileSync(filePath);
  const container = ctx.crypto.encryptContainer(filePath, plaintext);
  const tempPath = tempPathOf(ctx.crypto, filePath);
  writeTempFile(ctx, tempPath, filePath, container);
  fs.renameSync(tempPath, filePath);
  fsyncDir(path.dirname(filePath));
  ctx.crashHook?.("after-rename", filePath);
  ctx.store.markDone(ctx.batchId, filePath);
  ctx.crashHook?.("after-record", filePath);
}

function openContext(
  batchId: string,
  key: Buffer,
  options: VaultOptions
): Context {
  validateKey(key);
  if (!options || typeof options.stateDir !== "string" || options.stateDir.length === 0) {
    throw new ValidationError("options.stateDir must be a non-empty string");
  }
  fs.mkdirSync(options.stateDir, { recursive: true });
  const store = new TaskStore(path.join(options.stateDir, "sentinelvault-tasks.sqlite"));
  return {
    batchId,
    key,
    crypto: createBatchCrypto(key, batchId),
    store,
    crashHook: options.crashHook,
  };
}

function checkKey(ctx: Context): void {
  const record = ctx.store.getBatch(ctx.batchId);
  if (!record) {
    throw new VaultError("UNKNOWN_BATCH", `unknown batch: ${ctx.batchId}`);
  }
  if (record.keyHash !== sha256(ctx.key)) {
    throw new BatchConflictError(`batch ${ctx.batchId} was submitted with a different key`);
  }
}

function reconcileProgress(ctx: Context): BatchProgress {
  const files = ctx.store.listFiles(ctx.batchId).map((rec) => {
    let done = rec.done;
    if (!done && isFinalOnDisk(ctx, rec.path)) {
      // Crash after rename but before the record was persisted.
      ctx.store.markDone(ctx.batchId, rec.path);
      done = true;
    }
    return { path: rec.path, done };
  });
  const completed = files.filter((f) => f.done).length;
  return {
    batchId: ctx.batchId,
    total: files.length,
    completed,
    complete: completed === files.length,
    files,
  };
}

/**
 * Submit a new batch or resume an existing one. Idempotent: files that are
 * already final ciphertext of this batch are left byte-for-byte untouched.
 */
export async function submitBatch(
  batchId: string,
  files: string[],
  key: Buffer,
  options: VaultOptions
): Promise<BatchProgress> {
  validateManifest(batchId, files);
  const ctx = openContext(batchId, key, options);
  try {
    ctx.store.ensureBatch(
      {
        batchId,
        keyHash: sha256(key),
        manifestHash: manifestHash(files),
        createdAt: Date.now(),
      },
      files
    );
    for (const filePath of files) {
      // Remove a stale temp file left by an interrupted run of this batch.
      const tempPath = tempPathOf(ctx.crypto, filePath);
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* nothing to clean */
      }
      if (isFinalOnDisk(ctx, filePath)) {
        // Already final ciphertext of this batch: never touch its bytes again.
        ctx.store.markDone(batchId, filePath);
        continue;
      }
      const size = fs.statSync(filePath).size;
      if (size > MAX_FILE_SIZE) {
        throw new ValidationError(
          `file exceeds ${MAX_FILE_SIZE} bytes: ${filePath}`
        );
      }
      processFile(ctx, filePath);
    }
    return reconcileProgress(ctx);
  } finally {
    ctx.store.close();
  }
}

/**
 * Report progress reconciled with the on-disk state: a file counts as done
 * iff the target currently holds this batch's final ciphertext.
 */
export async function getProgress(
  batchId: string,
  key: Buffer,
  options: VaultOptions
): Promise<BatchProgress> {
  const ctx = openContext(batchId, key, options);
  try {
    checkKey(ctx);
    return reconcileProgress(ctx);
  } finally {
    ctx.store.close();
  }
}

/**
 * Verify and decrypt a completed file of this batch. Returns the exact
 * original bytes submitted for this batch. Throws and returns nothing if
 * the integrity check fails.
 */
export async function readPlaintext(
  batchId: string,
  filePath: string,
  key: Buffer,
  options: VaultOptions
): Promise<Buffer> {
  const ctx = openContext(batchId, key, options);
  try {
    checkKey(ctx);
    const known = ctx.store.listFiles(batchId).some((rec) => rec.path === filePath);
    if (!known) {
      throw new ValidationError(`file is not part of batch ${batchId}: ${filePath}`);
    }
    const container = fs.readFileSync(filePath);
    return ctx.crypto.decryptContainer(filePath, container);
  } finally {
    ctx.store.close();
  }
}
