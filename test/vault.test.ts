import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Vault } from '../src/index.js';
import type { CrashHooks } from '../src/index.js';
import { makeFixture, tempFilesIn, SimulatedCrash } from './helpers.js';

const BATCH = 'batch-001';

/** 向 fixture 追加一个跨多个写入块的大文件，便于模拟“写到一半”。 */
function addLargeFile(fx: ReturnType<typeof makeFixture>): void {
  const path = join(fx.dir, 'data', 'large.bin');
  const data = randomBytes(200 * 1024);
  writeFileSync(path, data);
  fx.files.push(path);
  fx.contents.set(path, data);
}

/** 目录下所有 .svltmp 临时文件（递归一层 data 目录）。 */
function allTemps(dir: string): string[] {
  return [...tempFilesIn(dir), ...tempFilesIn(join(dir, 'data'))];
}

test('基本流程：整批加密后可逐字节读回，目录无残留', () => {
  const fx = makeFixture(5);
  const vault = new Vault({ dbPath: fx.dbPath });
  const progress = vault.submit({ batchId: BATCH, files: fx.files, key: fx.key });

  assert.equal(progress.total, 5);
  assert.equal(progress.completed, 5);
  assert.equal(progress.complete, true);

  // 磁盘上的内容已不再是原文
  for (const path of fx.files) {
    assert.ok(!readFileSync(path).equals(fx.contents.get(path)!));
  }
  // 读回与提交时原文逐字节一致
  for (const path of fx.files) {
    const back = vault.readPlaintext(BATCH, fx.key, path);
    assert.ok(back.equals(fx.contents.get(path)!), `roundtrip mismatch: ${path}`);
  }
  // 进度与磁盘一致，且无临时文件残留
  const again = vault.progress(BATCH);
  assert.equal(again.complete, true);
  assert.deepEqual(allTemps(fx.dir), []);
  vault.close();
});

test('崩溃点1：密文写到一半时终止，续跑后完成且无残留', () => {
  const fx = makeFixture(4);
  addLargeFile(fx);
  let crashed = false;
  const hooks: CrashHooks = {
    onTempWriteChunk: (written, total) => {
      if (!crashed && written < total) {
        crashed = true;
        throw new SimulatedCrash();
      }
    },
  };
  const first = new Vault({ dbPath: fx.dbPath, hooks });
  assert.throws(
    () => first.submit({ batchId: BATCH, files: fx.files, key: fx.key }),
    SimulatedCrash,
  );
  // 崩溃现场：存在写了一半的候选密文临时文件
  assert.ok(allTemps(fx.dir).length > 0, 'expected a partial temp file');

  // 重新打开相同目录与 SQLite 续跑
  const second = new Vault({ dbPath: fx.dbPath });
  const progress = second.submit({ batchId: BATCH, files: fx.files, key: fx.key });
  assert.equal(progress.complete, true);
  for (const path of fx.files) {
    assert.ok(second.readPlaintext(BATCH, fx.key, path).equals(fx.contents.get(path)!));
  }
  assert.deepEqual(allTemps(fx.dir), []);
  second.close();
});

test('崩溃点2：目标已是最终密文但完成记录未持久化，续跑不重加密', () => {
  const fx = makeFixture(3);
  let renamed = 0;
  const hooks: CrashHooks = {
    // 第二个文件 rename 成功后、记录完成前崩溃
    onAfterRename: () => {
      renamed += 1;
      if (renamed === 2) throw new SimulatedCrash();
    },
  };
  const first = new Vault({ dbPath: fx.dbPath, hooks });
  assert.throws(
    () => first.submit({ batchId: BATCH, files: fx.files, key: fx.key }),
    SimulatedCrash,
  );

  // 崩溃瞬间前两个文件的最终密文
  const cipher0 = readFileSync(fx.files[0]!);
  const cipher1 = readFileSync(fx.files[1]!);
  assert.ok(!cipher0.equals(fx.contents.get(fx.files[0]!)!));

  // 新实例查询：进度必须与磁盘一致（前两个算完成，即使记录未落盘）
  const second = new Vault({ dbPath: fx.dbPath });
  const mid = second.progress(BATCH);
  assert.equal(mid.completed, 2);
  assert.equal(mid.complete, false);

  const done = second.submit({ batchId: BATCH, files: fx.files, key: fx.key });
  assert.equal(done.complete, true);

  // 中断前已完成的密文逐字节不变
  assert.ok(readFileSync(fx.files[0]!).equals(cipher0));
  assert.ok(readFileSync(fx.files[1]!).equals(cipher1));
  for (const path of fx.files) {
    assert.ok(second.readPlaintext(BATCH, fx.key, path).equals(fx.contents.get(path)!));
  }
  assert.deepEqual(allTemps(fx.dir), []);
  second.close();
});

test('崩溃点3：续跑过程中再次终止，最终仍能完成', () => {
  const fx = makeFixture(4);
  addLargeFile(fx);
  // 第一次：写临时文件中途崩溃
  let crash1 = false;
  const first = new Vault({
    dbPath: fx.dbPath,
    hooks: {
      onTempWriteChunk: (written, total) => {
        if (!crash1 && written < total) {
          crash1 = true;
          throw new SimulatedCrash();
        }
      },
    },
  });
  assert.throws(
    () => first.submit({ batchId: BATCH, files: fx.files, key: fx.key }),
    SimulatedCrash,
  );

  // 第二次（续跑）：rename 后再次崩溃
  let crash2 = false;
  const second = new Vault({
    dbPath: fx.dbPath,
    hooks: {
      onAfterRename: () => {
        if (!crash2) {
          crash2 = true;
          throw new SimulatedCrash();
        }
      },
    },
  });
  assert.throws(
    () => second.submit({ batchId: BATCH, files: fx.files, key: fx.key }),
    SimulatedCrash,
  );

  // 第三次：无故障续跑，必须完成
  const third = new Vault({ dbPath: fx.dbPath });
  const progress = third.submit({ batchId: BATCH, files: fx.files, key: fx.key });
  assert.equal(progress.complete, true);
  for (const path of fx.files) {
    assert.ok(third.readPlaintext(BATCH, fx.key, path).equals(fx.contents.get(path)!));
  }
  assert.deepEqual(allTemps(fx.dir), []);
  third.close();
});

test('本库有效密文可作为新批次普通输入，读回得到该密文本身', () => {
  const fx = makeFixture(2);
  const batchA = 'batch-A';
  const first = new Vault({ dbPath: fx.dbPath });
  first.submit({ batchId: batchA, files: fx.files, key: fx.key });

  // 此时磁盘上是 batchA 的密文；把它作为 batchB 的普通输入
  const cipherA0 = readFileSync(fx.files[0]!);
  const cipherA1 = readFileSync(fx.files[1]!);
  const batchB = 'batch-B';
  first.submit({ batchId: batchB, files: fx.files, key: fx.key });

  // batchB 读回必须逐字节等于 batchA 的密文（不跳过、不多解密）
  assert.ok(first.readPlaintext(batchB, fx.key, fx.files[0]!).equals(cipherA0));
  assert.ok(first.readPlaintext(batchB, fx.key, fx.files[1]!).equals(cipherA1));
  // batchA 视角下这些文件不再是 batchA 的最终密文
  assert.equal(first.progress(batchA).completed, 0);
  first.close();
});

test('完整性验证失败时不返回任何明文', () => {
  const fx = makeFixture(2);
  const vault = new Vault({ dbPath: fx.dbPath });
  vault.submit({ batchId: BATCH, files: fx.files, key: fx.key });

  // 篡改密文主体的一个字节（避开头部）
  const target = fx.files[1]!;
  const data = readFileSync(target);
  data[40] = data[40]! ^ 0x01;
  writeFileSync(target, data);

  assert.throws(() => vault.readPlaintext(BATCH, fx.key, target), /integrity/);
  // 错误的密钥同样不得返回明文
  const untouched = fx.files[0]!;
  assert.throws(() => vault.readPlaintext(BATCH, randomBytes(32), untouched));
  vault.close();
});

test('输入校验与重试一致性', () => {
  const fx = makeFixture(2);
  const vault = new Vault({ dbPath: fx.dbPath });

  // 密钥长度
  assert.throws(
    () => vault.submit({ batchId: 'x', files: fx.files, key: randomBytes(16) }),
    /32-byte/,
  );
  // 超过 500 个文件
  const many = Array.from({ length: 501 }, (_, i) => fx.files[i % 2]! + `.${i}`);
  assert.throws(
    () => vault.submit({ batchId: 'x', files: many, key: fx.key }),
    /500/,
  );
  // 超过 8 MiB 的文件
  const big = join(fx.dir, 'data', 'big.bin');
  writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.throws(
    () => vault.submit({ batchId: 'x', files: [big], key: fx.key }),
    /exceeds/,
  );

  // 正常提交后：同一标识换清单或换密钥必须报错
  vault.submit({ batchId: BATCH, files: fx.files, key: fx.key });
  assert.throws(
    () => vault.submit({ batchId: BATCH, files: [fx.files[0]!], key: fx.key }),
    /manifest/,
  );
  assert.throws(
    () => vault.submit({ batchId: BATCH, files: fx.files, key: randomBytes(32) }),
    /key/,
  );
  // 同一标识、相同清单与密钥重试：幂等完成
  const again = vault.submit({ batchId: BATCH, files: fx.files, key: fx.key });
  assert.equal(again.complete, true);
  vault.close();
});

test('查询未知批次报错；读回未完成文件报错', () => {
  const fx = makeFixture(1);
  const vault = new Vault({ dbPath: fx.dbPath });
  assert.throws(() => vault.progress('nope'), /unknown batch/);

  // 制造“仍是原文”的待处理状态：直接登记批次但不加密
  let crashed = false;
  const flaky = new Vault({
    dbPath: fx.dbPath,
    hooks: {
      onBeforeRename: () => {
        if (!crashed) {
          crashed = true;
          throw new SimulatedCrash();
        }
      },
    },
  });
  assert.throws(
    () => flaky.submit({ batchId: BATCH, files: fx.files, key: fx.key }),
    SimulatedCrash,
  );
  const st = vault.progress(BATCH);
  assert.equal(st.completed, 0);
  assert.throws(() => vault.readPlaintext(BATCH, fx.key, fx.files[0]!));
  vault.close();
});
