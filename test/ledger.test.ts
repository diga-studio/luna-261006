import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuditLedger } from "../src/index.js";
import type { Credential } from "../src/index.js";

function freshDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-test-"));
  return { dir, path: join(dir, "audit.db") };
}

function tamper(path: string, fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  fn(db);
  db.close();
}

test("交错追加后按主体擦除：内容消失、其余记录逐项一致、新旧凭据均可核验", () => {
  const { path } = freshDbPath();
  const ledger = AuditLedger.open(path);

  // 交错追加：目标主体 target 覆盖首部、中部、尾部。
  const inputs: Array<{ subject: string; body: unknown }> = [
    { subject: "target", body: { op: "login", at: 1 } }, // 1 首部
    { subject: "alice", body: { op: "read", key: "a" } }, // 2
    { subject: "bob", body: [1, 2, { nested: true }] }, // 3
    { subject: "target", body: { op: "sudo", cmd: "ls" } }, // 4 中部
    { subject: "alice", body: "plain string body" }, // 5
    { subject: "carol", body: 42 }, // 6
    { subject: "target", body: { op: "logout" } }, // 7 尾部
  ];
  const credentials: Credential[] = [];
  inputs.forEach((input, i) => {
    const result = ledger.append(input.subject, input.body);
    assert.equal(result.seq, i + 1);
    credentials.push(result.credential);
  });

  // 无匹配主体的擦除不改变账本与凭据。
  const beforeNoop = ledger.currentCredential();
  const noop = ledger.eraseSubject("nobody");
  assert.equal(noop.erased, 0);
  assert.deepEqual(noop.credential, beforeNoop);

  // 擦除 target（首部/中部/尾部各一条）。
  const eraseResult = ledger.eraseSubject("target");
  assert.equal(eraseResult.erased, 3);
  credentials.push(eraseResult.credential);

  // 其余存活记录与独立保存的原始输入逐项一致。
  const expectedSurvivors = inputs
    .map((input, i) => ({ seq: i + 1, ...input }))
    .filter((r) => r.subject !== "target");
  const live = ledger.listLiveRecords();
  assert.deepEqual(live, expectedSurvivors);
  for (const seq of [1, 4, 7]) assert.equal(ledger.getLiveRecord(seq), null);

  // 库管理的逻辑数据中被擦除主体不留痕迹（墓碑仅存完整性材料）。
  tamper(path, (db) => {
    const rows = db
      .prepare("SELECT subject, body, erased FROM records ORDER BY seq")
      .all() as Array<{ subject: string | null; body: string | null; erased: number }>;
    for (const row of rows) {
      assert.ok(row.subject === null || row.subject !== "target");
      if (row.body !== null) assert.ok(!row.body.includes("target"));
    }
    const tombs = db
      .prepare("SELECT subject, body FROM records WHERE erased = 1")
      .all() as Array<{ subject: string | null; body: string | null }>;
    assert.equal(tombs.length, 3);
    for (const t of tombs) {
      assert.equal(t.subject, null);
      assert.equal(t.body, null);
    }
  });

  // 同主体擦除后追加的新记录正常保留，不受旧擦除影响。
  const reAppend = ledger.append("target", { op: "login-again" });
  assert.equal(reAppend.seq, 8);
  credentials.push(reAppend.credential);
  assert.deepEqual(ledger.getLiveRecord(8), {
    seq: 8,
    subject: "target",
    body: { op: "login-again" },
  });
  ledger.close();

  // 重新打开数据库：新旧凭据全部核验通过。
  const reopened = AuditLedger.open(path);
  for (const [i, credential] of credentials.entries()) {
    const result = reopened.verify(credential);
    assert.ok(result.ok, `凭据 #${i} 应核验通过: ${result.ok === false ? result.reason : ""}`);
  }
  assert.deepEqual(reopened.listLiveRecords(), [
    ...expectedSurvivors,
    { seq: 8, subject: "target", body: { op: "login-again" } },
  ]);
  reopened.close();
});

test("正文或主体被篡改时核验失败", () => {
  const { path } = freshDbPath();
  const ledger = AuditLedger.open(path);
  ledger.append("alice", { secret: "original" });
  ledger.append("bob", { n: 2 });
  const latest = ledger.currentCredential();
  ledger.close();

  tamper(path, (db) => {
    db.prepare("UPDATE records SET body = ? WHERE seq = 1").run('{"secret":"forged"}');
  });
  let ledger2 = AuditLedger.open(path);
  assert.equal(ledger2.verify(latest).ok, false);
  ledger2.close();

  tamper(path, (db) => {
    db.prepare("UPDATE records SET body = ? WHERE seq = 1").run('{"secret":"original"}');
    db.prepare("UPDATE records SET subject = ? WHERE seq = 1").run("mallory");
  });
  ledger2 = AuditLedger.open(path);
  const result = ledger2.verify(latest);
  assert.equal(result.ok, false);
  ledger2.close();
});

test("伪造擦除（无擦除事实的墓碑、伪造擦除操作）核验失败", () => {
  const { path } = freshDbPath();
  const ledger = AuditLedger.open(path);
  ledger.append("alice", { a: 1 });
  ledger.append("bob", { b: 2 });
  const latest = ledger.currentCredential();
  ledger.close();

  // 攻击者把存活记录伪造成墓碑（保留承诺哈希）。
  tamper(path, (db) => {
    db.prepare("UPDATE records SET subject = NULL, body = NULL, erased = 1 WHERE seq = 1").run();
  });
  let ledger2 = AuditLedger.open(path);
  assert.equal(ledger2.verify(latest).ok, false);
  ledger2.close();

  // 进一步伪造一条擦除操作日志也无法通过最新凭据。
  tamper(path, (db) => {
    db.prepare("INSERT INTO ops (op_seq, kind, payload, state_hash) VALUES (3, 'erase', ?, ?)").run(
      '{"seqs":[1]}',
      "0".repeat(64),
    );
  });
  ledger2 = AuditLedger.open(path);
  assert.equal(ledger2.verify(latest).ok, false);
  ledger2.close();
});

test("整库回滚被最新凭据拒绝", () => {
  const { dir, path } = freshDbPath();
  const backup = join(dir, "backup.db");
  const ledger = AuditLedger.open(path);
  ledger.append("alice", { a: 1 });
  ledger.close();
  copyFileSync(path, backup);

  const ledger2 = AuditLedger.open(path);
  ledger2.append("bob", { b: 2 });
  ledger2.eraseSubject("alice");
  const latest = ledger2.currentCredential();
  ledger2.close();

  // 攻击者将整个数据库回滚到旧快照。
  copyFileSync(backup, path);
  const ledger3 = AuditLedger.open(path);
  const result = ledger3.verify(latest);
  assert.equal(result.ok, false);
  ledger3.close();
  rmSync(dir, { recursive: true, force: true });
});

test("未授权删除、调换记录与末尾截断均被拒绝", () => {
  const { path } = freshDbPath();
  const ledger = AuditLedger.open(path);
  ledger.append("alice", { a: 1 });
  ledger.append("bob", { b: 2 });
  ledger.append("carol", { c: 3 });
  const latest = ledger.currentCredential();
  ledger.close();

  // 未授权删除中间记录。
  tamper(path, (db) => {
    db.prepare("DELETE FROM records WHERE seq = 2").run();
  });
  let l2 = AuditLedger.open(path);
  assert.equal(l2.verify(latest).ok, false);
  l2.close();

  // 调换两条存活记录的主体。
  tamper(path, (db) => {
    db.prepare("UPDATE records SET subject = 'carol' WHERE seq = 1").run();
    db.prepare("UPDATE records SET subject = 'alice' WHERE seq = 3").run();
  });
  l2 = AuditLedger.open(path);
  assert.equal(l2.verify(latest).ok, false);
  l2.close();

  // 末尾截断（删除最后一条记录与对应操作）。
  tamper(path, (db) => {
    db.prepare("DELETE FROM records WHERE seq = 3").run();
    db.prepare("DELETE FROM ops WHERE op_seq = 3").run();
  });
  l2 = AuditLedger.open(path);
  assert.equal(l2.verify(latest).ok, false);
  l2.close();
});

test("创世凭据与后续演化共存：空账本凭据始终可核验", () => {
  const { path } = freshDbPath();
  const ledger = AuditLedger.open(path);
  const genesis = ledger.currentCredential();
  assert.ok(ledger.verify(genesis).ok);
  ledger.append("alice", { a: 1 });
  ledger.eraseSubject("alice");
  ledger.append("bob", { b: 2 });
  assert.ok(ledger.verify(genesis).ok);
  assert.ok(ledger.verify(ledger.currentCredential()).ok);
  ledger.close();
});
