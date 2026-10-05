import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "../src/index.js";
import type { Credential } from "../src/index.js";

function freshDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-test-"));
  return { dir, path: join(dir, "ledger.sqlite") };
}

interface Input {
  subject: string;
  body: unknown;
}

/** 交错追加多个主体，使目标主体 alice 覆盖账本首部、中部和尾部。 */
function interleavedInputs(): Input[] {
  return [
    { subject: "alice", body: { op: "login", terminal: "tty1" } },          // 首部
    { subject: "bob", body: { op: "read-secret", id: 1 } },
    { subject: "carol", body: { op: "sudo", cmd: "systemctl restart x" } },
    { subject: "alice", body: { op: "view", path: "/etc/shadow" } },        // 中部
    { subject: "bob", body: { op: "write", path: "/tmp/note", n: [1, 2] } },
    { subject: "carol", body: { op: "logout" } },
    { subject: "alice", body: { op: "export", format: "json", ok: true } }, // 尾部
  ];
}

test("交错追加后按主体擦除：内容与关联消失，其余记录与原始输入一致，新旧凭据均可核验", () => {
  const { dir, path } = freshDbPath();
  try {
    const inputs = interleavedInputs();
    const ledger = Ledger.open(path);

    // 逐项追加并保存每一次产生的凭据。
    const credentials: Credential[] = [];
    const seqs: number[] = [];
    for (const input of inputs) {
      const result = ledger.append(input.subject, input.body);
      seqs.push(result.seq);
      credentials.push(result.credential);
    }
    // 序号不可复用且递增。
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7]);
    const preEraseCredential = credentials[credentials.length - 1];

    // 擦除 alice（覆盖首部、中部、尾部）。
    const eraseResult = ledger.erase("alice");
    assert.equal(eraseResult.erased, true);
    assert.deepEqual(eraseResult.erasedSeqs, [1, 4, 7]);
    const postEraseCredential = eraseResult.credential;
    assert.notEqual(postEraseCredential.headHash, preEraseCredential.headHash);

    // 其余记录与独立保存的原始输入逐项一致，序号与顺序不变。
    const survivors = ledger.records();
    const expectedSurvivors = [
      { seq: 2, ...inputs[1] },
      { seq: 3, ...inputs[2] },
      { seq: 5, ...inputs[4] },
      { seq: 6, ...inputs[5] },
    ];
    assert.equal(survivors.length, expectedSurvivors.length);
    for (let i = 0; i < survivors.length; i++) {
      assert.equal(survivors[i].seq, expectedSurvivors[i].seq);
      assert.equal(survivors[i].subject, expectedSurvivors[i].subject);
      assert.deepEqual(survivors[i].body, expectedSurvivors[i].body);
    }

    // 库中不再存在 alice 的明文、正文与检索关联。
    const raw = new DatabaseSync(path);
    const leaked = raw
      .prepare(
        "SELECT COUNT(*) AS c FROM entries WHERE subject = 'alice' OR body LIKE '%alice%' OR body LIKE '%shadow%' OR body LIKE '%tty1%' OR body LIKE '%export%'"
      )
      .get() as { c: number };
    assert.equal(leaked.c, 0);
    const tombstones = raw
      .prepare("SELECT seq, subject, body, erased FROM entries WHERE erased = 1 ORDER BY seq")
      .all() as unknown as { seq: number; subject: unknown; body: unknown }[];
    assert.deepEqual(tombstones.map((t) => t.seq), [1, 4, 7]);
    for (const t of tombstones) {
      assert.equal(t.subject, null);
      assert.equal(t.body, null);
    }
    raw.close();

    // 同主体的新记录正常保留，不受旧擦除影响。
    const reAppend = ledger.append("alice", { op: "login-again" });
    assert.equal(reAppend.seq, 9);
    const aliceNow = ledger.records().filter((r) => r.subject === "alice");
    assert.equal(aliceNow.length, 1);
    assert.deepEqual(aliceNow[0].body, { op: "login-again" });
    const latestCredential = reAppend.credential;
    ledger.close();

    // 重新打开数据库：旧凭据（追加期、擦除后）与最新凭据均能核验。
    const reopened = Ledger.open(path);
    for (const credential of [...credentials, postEraseCredential, latestCredential]) {
      const result = reopened.verify(credential);
      assert.equal(result.ok, true, "credential should verify: " + (result.reason ?? ""));
    }
    // 擦除前的旧凭据证明其前缀未被替换。
    assert.equal(reopened.verify(preEraseCredential).ok, true);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无匹配记录的擦除不改变账本和凭据", () => {
  const { dir, path } = freshDbPath();
  try {
    const ledger = Ledger.open(path);
    ledger.append("alice", { a: 1 });
    const before = ledger.currentCredential();
    const result = ledger.erase("nobody");
    assert.equal(result.erased, false);
    assert.deepEqual(result.erasedSeqs, []);
    assert.deepEqual(result.credential, before);
    assert.deepEqual(ledger.currentCredential(), before);
    assert.equal(ledger.records().length, 1);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("篡改存活正文：核验失败", () => {
  const { dir, path } = freshDbPath();
  try {
    const ledger = Ledger.open(path);
    ledger.append("alice", { op: "login" });
    const credential = ledger.append("bob", { op: "read" }).credential;
    ledger.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE entries SET body = ? WHERE seq = 1").run('{"op":"format-disk"}');
    raw.close();

    const reopened = Ledger.open(path);
    assert.equal(reopened.verify(credential).ok, false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("篡改存活主体：核验失败", () => {
  const { dir, path } = freshDbPath();
  try {
    const ledger = Ledger.open(path);
    const credential = ledger.append("alice", { op: "login" }).credential;
    ledger.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE entries SET subject = 'mallory' WHERE seq = 1").run();
    raw.close();

    const reopened = Ledger.open(path);
    assert.equal(reopened.verify(credential).ok, false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("伪造擦除（直接墓碑化存活记录）：核验失败", () => {
  const { dir, path } = freshDbPath();
  try {
    const ledger = Ledger.open(path);
    ledger.append("alice", { op: "login" });
    const credential = ledger.append("bob", { op: "read" }).credential;
    ledger.close();

    // 攻击者把 alice 的记录伪装成“已擦除”。
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE entries SET erased = 1, subject = NULL, body = NULL WHERE seq = 1").run();
    raw.close();

    const reopened = Ledger.open(path);
    const result = reopened.verify(credential);
    assert.equal(result.ok, false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("整库回滚：最新凭据核验失败，回滚前的旧凭据仍可用", () => {
  const { dir, path } = freshDbPath();
  const snapshot = join(dir, "snapshot.sqlite");
  try {
    const ledger = Ledger.open(path);
    ledger.append("alice", { op: "login" });
    const oldCredential = ledger.append("bob", { op: "read" }).credential;
    ledger.close();
    copyFileSync(path, snapshot);

    const ledger2 = Ledger.open(path);
    ledger2.append("carol", { op: "sudo" });
    ledger2.erase("alice");
    const latestCredential = ledger2.currentCredential();
    ledger2.close();

    // 攻击者用旧快照整体替换数据库。
    copyFileSync(snapshot, path);

    const reopened = Ledger.open(path);
    // 最新凭据拒绝被回滚的库（截断/前缀缺失）。
    assert.equal(reopened.verify(latestCredential).ok, false);
    // 快照时代的旧凭据依然有效，证明其前缀未被替换。
    assert.equal(reopened.verify(oldCredential).ok, true);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("调换记录顺序：核验失败", () => {
  const { dir, path } = freshDbPath();
  try {
    const ledger = Ledger.open(path);
    ledger.append("alice", { op: "a" });
    const credential = ledger.append("bob", { op: "b" }).credential;
    ledger.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE entries SET seq = 3 WHERE seq = 1").run();
    raw.prepare("UPDATE entries SET seq = 1 WHERE seq = 2").run();
    raw.prepare("UPDATE entries SET seq = 2 WHERE seq = 3").run();
    raw.close();

    const reopened = Ledger.open(path);
    assert.equal(reopened.verify(credential).ok, false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未经授权删除记录：核验失败", () => {
  const { dir, path } = freshDbPath();
  try {
    const ledger = Ledger.open(path);
    ledger.append("alice", { op: "a" });
    ledger.append("bob", { op: "b" });
    const credential = ledger.append("carol", { op: "c" }).credential;
    ledger.close();

    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM entries WHERE seq = 2").run();
    raw.close();

    const reopened = Ledger.open(path);
    assert.equal(reopened.verify(credential).ok, false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("截断末尾：核验失败", () => {
  const { dir, path } = freshDbPath();
  try {
    const ledger = Ledger.open(path);
    ledger.append("alice", { op: "a" });
    const credential = ledger.append("bob", { op: "b" }).credential;
    ledger.close();

    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM entries WHERE seq = 2").run();
    raw.close();

    const reopened = Ledger.open(path);
    assert.equal(reopened.verify(credential).ok, false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("合法擦除通过核验，且擦除事实不能被伪造到其他主体", () => {
  const { dir, path } = freshDbPath();
  try {
    const ledger = Ledger.open(path);
    ledger.append("alice", { op: "a" });
    ledger.append("bob", { op: "b" });
    ledger.erase("alice");
    const credential = ledger.currentCredential();
    assert.equal(ledger.verify(credential).ok, true);
    ledger.close();

    // 攻击者把擦除事件改指到 bob 的记录上。
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE entries SET erased_seqs = '[2]' WHERE kind = 'erase'").run();
    raw.close();

    const reopened = Ledger.open(path);
    assert.equal(reopened.verify(credential).ok, false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
