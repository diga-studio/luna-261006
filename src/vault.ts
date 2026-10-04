import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  batchHashOf,
  decodeHeader,
  HEADER_BYTES,
} from './envelope.js';
import { decryptEnvelope, encryptEnvelope, splitEnvelope } from './crypto.js';
import { Store } from './store.js';
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_BATCH,
  type BatchProgress,
  type CrashHooks,
  type FileProgress,
  type SubmitBatchRequest,
  type VaultOptions,
} from './types.js';

const WRITE_CHUNK_BYTES = 64 * 1024;

/** 本批次某目标文件的候选密文临时文件路径（同目录，保证 rename 原子性）。 */
function tempPathFor(target: string, batchHashHex: string): string {
  return join(dirname(target), `.svltmp-${batchHashHex}-${String(process.pid)}`);
}

/** 判断是否本批次遗留的临时文件名。 */
function isTempNameOf(name: string, batchHashHex: string): boolean {
  return name.startsWith(`.svltmp-${batchHashHex}-`);
}

export class Vault {
  private readonly store: Store;
  private readonly hooks: CrashHooks;

  constructor(options: VaultOptions) {
    this.store = new Store(options.dbPath);
    this.hooks = options.hooks ?? {};
  }

  /** 提交新批次或续跑既有批次；返回最终进度。 */
  submit(request: SubmitBatchRequest): BatchProgress {
    const { batchId, files, key } = request;
    this.validateRequest(batchId, files, key);
    this.store.ensureBatch(batchId, files, key);
    const batchHash = batchHashOf(batchId);
    const batchHashHex = batchHash.toString('hex');

    for (const path of files) {
      if (this.isFinalCiphertext(path, batchHash)) {
        // 已完成（可能上次崩溃前来不及记录）：逐字节保留，仅补记进度。
        this.store.markDone(batchId, path);
        continue;
      }
      this.encryptInPlace(batchId, batchHash, batchHashHex, key, path);
    }
    this.sweepTempFiles(files, batchHashHex);
    return this.progress(batchId);
  }

  /** 查询批次进度；完成状态以磁盘实际内容为准。 */
  progress(batchId: string): BatchProgress {
    const batch = this.store.getBatch(batchId);
    if (batch === null) {
      throw new Error(`unknown batch: ${batchId}`);
    }
    const files = JSON.parse(batch.manifestJson) as string[];
    const batchHash = batchHashOf(batchId);
    const entries: FileProgress[] = files.map((path) => ({
      path,
      done: this.isFinalCiphertext(path, batchHash),
    }));
    const completed = entries.filter((e) => e.done).length;
    const tempsLeft = this.leftoverTemps(files, batchHashOf(batchId).toString('hex'));
    return {
      batchId,
      total: entries.length,
      completed,
      complete: completed === entries.length && tempsLeft.length === 0,
      files: entries,
    };
  }

  /** 验证并读回已完成文件的本批次原始字节。 */
  readPlaintext(batchId: string, key: Buffer, path: string): Buffer {
    const batch = this.store.getBatch(batchId);
    if (batch === null) {
      throw new Error(`unknown batch: ${batchId}`);
    }
    const files = JSON.parse(batch.manifestJson) as string[];
    if (!files.includes(path)) {
      throw new Error(`path not in batch manifest: ${path}`);
    }
    const data = readFileSync(path);
    const parsed = splitEnvelope(data);
    if (
      parsed === null ||
      !parsed.header.batchHash.equals(batchHashOf(batchId))
    ) {
      throw new Error(`file is not final ciphertext of batch ${batchId}: ${path}`);
    }
    // 完整性验证失败时 decryptEnvelope 抛出，不会返回任何明文。
    return decryptEnvelope(key, parsed.header, parsed.body);
  }

  close(): void {
    this.store.close();
  }

  private validateRequest(batchId: string, files: string[], key: Buffer): void {
    if (typeof batchId !== 'string' || batchId.length === 0) {
      throw new Error('batchId must be a non-empty string');
    }
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new Error('key must be a 32-byte Buffer');
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('files must be a non-empty array');
    }
    if (files.length > MAX_FILES_PER_BATCH) {
      throw new Error(`too many files: max ${MAX_FILES_PER_BATCH} per batch`);
    }
    if (new Set(files).size !== files.length) {
      throw new Error('files contain duplicate paths');
    }
    const batchHash = batchHashOf(batchId);
    for (const path of files) {
      const st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink()) {
        throw new Error(`not a regular file: ${path}`);
      }
      if (st.nlink > 1) {
        throw new Error(`hard links are not supported: ${path}`);
      }
      // 已是本批次最终密文的文件属于续跑场景，不按原文大小限制。
      if (!this.isFinalCiphertext(path, batchHash) && st.size > MAX_FILE_BYTES) {
        throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
      }
    }
  }

  /** 目标是否已是本批次最终密文（仅凭信封头识别，不需要密钥）。 */
  private isFinalCiphertext(path: string, batchHash: Buffer): boolean {
    let head: Buffer;
    try {
      head = Buffer.alloc(HEADER_BYTES);
      const fd = openSync(path, 'r');
      try {
        const n = readSync(fd, head, 0, head.length, 0);
        if (n < HEADER_BYTES) return false;
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
    const header = decodeHeader(head);
    return header !== null && header.batchHash.equals(batchHash);
  }

  /**
   * 单文件原地加密：写临时文件 → fsync → 原子 rename → 记录完成。
   * 任意时刻崩溃，目标路径要么是完整原文，要么是完整最终密文。
   */
  private encryptInPlace(
    batchId: string,
    batchHash: Buffer,
    batchHashHex: string,
    key: Buffer,
    path: string,
  ): void {
    const plaintext = readFileSync(path);
    const envelope = encryptEnvelope(key, batchId, plaintext);
    const temp = tempPathFor(path, batchHashHex);
    // 清理上次崩溃可能留下的写了一半的候选密文。
    rmSync(temp, { force: true });

    const fd = openSync(temp, 'w');
    try {
      let written = 0;
      while (written < envelope.length) {
        const end = Math.min(written + WRITE_CHUNK_BYTES, envelope.length);
        written += writeSync(fd, envelope, written, end - written);
        this.hooks.onTempWriteChunk?.(written, envelope.length);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.hooks.onBeforeRename?.(path);
    renameSync(temp, path);
    this.hooks.onAfterRename?.(path);
    this.store.markDone(batchId, path);
    this.hooks.onAfterRecord?.(path);
  }

  /** 删除本批次文件对应的残留临时文件（含历史进程 pid 的命名）。 */
  private sweepTempFiles(files: string[], batchHashHex: string): void {
    for (const path of files) {
      const dir = dirname(path);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (isTempNameOf(name, batchHashHex)) {
          rmSync(join(dir, name), { force: true });
        }
      }
    }
  }

  private leftoverTemps(files: string[], batchHashHex: string): string[] {
    const found: string[] = [];
    const seenDirs = new Set<string>();
    for (const path of files) {
      const dir = dirname(path);
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (isTempNameOf(name, batchHashHex)) found.push(join(dir, name));
      }
    }
    return found;
  }
}
