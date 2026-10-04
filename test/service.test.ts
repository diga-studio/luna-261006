import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisposableDomainService, DomainStore, normalizeDomain } from "../src/index";
import type { CheckResult } from "../src/index";

function makeService(): { service: DisposableDomainService; dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "ded-test-"));
  const dbPath = join(dir, "domains.sqlite");
  return { service: new DisposableDomainService(dbPath), dir, dbPath };
}

function cleanup(service: DisposableDomainService, dir: string): void {
  service.close();
  rmSync(dir, { recursive: true, force: true });
}

/** 独立计算：不经过被测匹配逻辑，逐标签后缀比对给定规则表。 */
function independentCheck(email: string, rules: string[]): { disposable: boolean; matchedRule: string | null } {
  const at = email.lastIndexOf("@");
  const domain = normalizeDomain(at === -1 ? email : email.slice(at + 1));
  const normalized = rules.map(normalizeDomain);
  let best: string | null = null;
  for (const rule of normalized) {
    const labels = rule.split(".");
    const domainLabels = domain.split(".");
    if (labels.length > domainLabels.length) continue;
    const suffix = domainLabels.slice(domainLabels.length - labels.length).join(".");
    if (suffix === rule) {
      if (best === null || rule.split(".").length > best.split(".").length) {
        best = rule;
      }
    }
  }
  return { disposable: best !== null, matchedRule: best };
}

test("同一名单跨越两次发布：批次固定受理时修订，含 Unicode/Punycode、根点、伪后缀", () => {
  const { service, dir } = makeService();
  try {
    const rev1Rules = ["trash.test", "münchen.de", "xn--nxasmq6b.example"];
    service.beginImport(1);
    service.importChunk(1, rev1Rules);
    service.commitImport(1);
    assert.equal(service.currentRevision(), 1);

    // 批次在两次发布之间受理，固定修订 1。
    const batchA = service.beginBatch();
    assert.equal(batchA.revision, 1);

    const firstLines = [
      "user@MÜNCHEN.de",              // Unicode 大写
      "user@xn--mnchen-3ya.de",       // 对应 Punycode，等价命中
      "user@a.trash.test.",           // 末尾根点忽略，子域命中
      "user@nottrash.test",           // 伪后缀，不命中
    ];
    const delivered: CheckResult[] = firstLines.map((line) => batchA.check(line));

    // 第二次发布：整份替换，去掉 trash.test，新增 newtrash.test。
    const rev2Rules = ["newtrash.test", "münchen.de"];
    service.beginImport(2);
    service.importChunk(2, rev2Rules);
    service.commitImport(2);
    assert.equal(service.currentRevision(), 2);

    // 同一批次继续检查，仍使用受理时的修订 1。
    const restLines = ["user@a.trash.test", "user@newtrash.test", "user@sub.xn--nxasmq6b.example"];
    delivered.push(...restLines.map((line) => batchA.check(line)));

    // 全部结果与受理时域名表的独立计算完全一致。
    const allLines = [...firstLines, ...restLines];
    for (let i = 0; i < allLines.length; i++) {
      const expected = independentCheck(allLines[i], rev1Rules);
      assert.equal(delivered[i].disposable, expected.disposable, `line ${allLines[i]}`);
      assert.equal(delivered[i].matchedRule, expected.matchedRule, `line ${allLines[i]}`);
      assert.equal(delivered[i].revision, 1);
    }
    assert.equal(delivered[0].disposable, true);
    assert.equal(delivered[1].disposable, true);
    assert.equal(delivered[2].disposable, true);
    assert.equal(delivered[3].disposable, false);
    assert.equal(delivered[4].disposable, true);   // trash.test 在修订 1 仍有效
    assert.equal(delivered[5].disposable, false);  // newtrash.test 在修订 1 不存在

    // 新批次使用受理时的新修订。
    const batchB = service.beginBatch();
    assert.equal(batchB.revision, 2);
    const newLines = ["user@a.trash.test", "user@newtrash.test", "user@münchen.de"];
    for (const line of newLines) {
      const expected = independentCheck(line, rev2Rules);
      const actual = batchB.check(line);
      assert.equal(actual.disposable, expected.disposable, `line ${line}`);
      assert.equal(actual.matchedRule, expected.matchedRule, `line ${line}`);
      assert.equal(actual.revision, 2);
    }
    assert.equal(batchB.check("user@a.trash.test").disposable, false);
    assert.equal(batchB.check("user@newtrash.test").disposable, true);

    batchA.finish();
    batchB.finish();
  } finally {
    cleanup(service, dir);
  }
});

test("新修订先完成、旧修订后完成：当前修订不回滚，批次看不到半份新表", () => {
  const { service, dir } = makeService();
  try {
    service.beginImport(1);
    service.importChunk(1, ["old.test"]);
    service.commitImport(1);

    // 两个导入交错分段到达。
    service.beginImport(3);
    service.importChunk(3, ["a3.test"]);
    service.beginImport(2);
    service.importChunk(2, ["a2.test"]);

    // 导入进行中的批次只能看到已生效的修订 1，看不到半份新表。
    const during = service.beginBatch();
    assert.equal(during.revision, 1);
    assert.equal(during.check("x@a3.test").disposable, false);
    assert.equal(during.check("x@a2.test").disposable, false);
    assert.equal(during.check("x@old.test").disposable, true);
    during.finish();

    // 新修订 3 先完成。
    service.importChunk(3, ["b3.test"]);
    service.commitImport(3);
    assert.equal(service.currentRevision(), 3);

    // 旧修订 2 后完成，不能回滚新表。
    service.importChunk(2, ["b2.test"]);
    service.commitImport(2);
    assert.equal(service.currentRevision(), 3);

    const batch = service.beginBatch();
    assert.equal(batch.revision, 3);
    assert.equal(batch.check("x@a3.test").disposable, true);
    assert.equal(batch.check("x@b3.test").disposable, true);
    assert.equal(batch.check("x@a2.test").disposable, false);
    assert.equal(batch.check("x@old.test").disposable, false);
    batch.finish();

    // 中止的导入不留痕迹。
    service.beginImport(4);
    service.importChunk(4, ["half.test"]);
    service.abortImport(4);
    const after = service.beginBatch();
    assert.equal(after.revision, 3);
    assert.equal(after.check("x@half.test").disposable, false);
    after.finish();
  } finally {
    cleanup(service, dir);
  }
});

test("标签边界匹配与最长规则优先，归一化后重复规则视为一条", () => {
  const { service, dir, dbPath } = makeService();
  try {
    service.beginImport(1);
    service.importChunk(1, [
      "trash.test",
      "a.trash.test",
      "München.de",
      "xn--mnchen-3ya.de",   // 与上一条归一化后重复
      "münchen.de.",         // 末尾根点，仍重复
    ]);
    service.commitImport(1);

    const store = new DomainStore(dbPath);
    const domains = store.loadDomains(1);
    store.close();
    assert.equal(domains.length, 3);
    assert.ok(domains.includes("xn--mnchen-3ya.de"));

    const batch = service.beginBatch();
    // 自身与子域命中，完整标签边界。
    assert.equal(batch.check("u@trash.test").matchedRule, "trash.test");
    assert.equal(batch.check("u@x.trash.test").matchedRule, "trash.test");
    // 多条规则命中时返回标签最多者。
    assert.equal(batch.check("u@x.a.trash.test").matchedRule, "a.trash.test");
    assert.equal(batch.check("u@a.trash.test").matchedRule, "a.trash.test");
    // 伪后缀不命中。
    assert.equal(batch.check("u@nottrash.test").disposable, false);
    assert.equal(batch.check("u@trash.test.evil.com").disposable, false);
    // ß 与 ss 不等价。
    service.beginImport(2);
    service.importChunk(2, ["faß.de"]);
    service.commitImport(2);
    const batch2 = service.beginBatch();
    assert.equal(batch2.check("u@faß.de").disposable, true);
    assert.equal(batch2.check("u@fass.de").disposable, false);
    batch.finish();
    batch2.finish();
  } finally {
    cleanup(service, dir);
  }
});

test("取消批次：已交付结果不撤回，取消后不再交付", () => {
  const { service, dir } = makeService();
  try {
    service.beginImport(1);
    service.importChunk(1, ["trash.test"]);
    service.commitImport(1);

    const batch = service.beginBatch();
    const delivered = batch.check("u@trash.test");
    assert.equal(delivered.disposable, true);

    batch.cancel();
    assert.throws(() => batch.check("u@trash.test"), /cancelled/);
    assert.throws(() => batch.finish(), /cancelled/);
    assert.throws(() => batch.cancel(), /cancelled/);
    // 已交付结果保持原样。
    assert.equal(delivered.disposable, true);
    assert.equal(delivered.matchedRule, "trash.test");
  } finally {
    cleanup(service, dir);
  }
});

test("修订回收：失效且无人使用的修订被回收，被占用的保持可读", () => {
  const { service, dir, dbPath } = makeService();
  try {
    service.beginImport(1);
    service.importChunk(1, ["one.test"]);
    service.commitImport(1);

    const batchA = service.beginBatch(); // 占用修订 1
    service.beginImport(2);
    service.importChunk(2, ["two.test"]);
    service.commitImport(2); // 触发回收，但修订 1 仍被 batchA 使用

    const store = new DomainStore(dbPath);
    assert.deepEqual(new Set(store.loadDomains(1)), new Set(["one.test"])); // 保持可读
    assert.deepEqual(new Set(store.loadDomains(2)), new Set(["two.test"]));

    batchA.finish(); // 释放后修订 1 被回收
    assert.throws(() => store.loadDomains(1), /not committed|no import/);
    assert.deepEqual(new Set(store.loadDomains(2)), new Set(["two.test"]));
    store.close();

    // 修订 1 的数据被回收不影响仍活跃的批次结果（批次持有快照）。
    const batchB = service.beginBatch();
    assert.equal(batchB.check("u@two.test").disposable, true);
    assert.equal(batchB.check("u@one.test").disposable, false);
    batchB.finish();
  } finally {
    cleanup(service, dir);
  }
});

test("初始生效修订为 0，对应空表；非法修订号被拒绝", () => {
  const { service, dir } = makeService();
  try {
    assert.equal(service.currentRevision(), 0);
    const batch = service.beginBatch();
    assert.equal(batch.revision, 0);
    assert.equal(batch.check("u@anything.test").disposable, false);
    batch.finish();

    assert.throws(() => service.beginImport(0), /positive integer/);
    assert.throws(() => service.beginImport(-3), /positive integer/);
    assert.throws(() => service.beginImport(1.5), /positive integer/);
    service.beginImport(1);
    assert.throws(() => service.beginImport(1), /already exists/);
    service.commitImport(1);
    assert.throws(() => service.beginImport(1), /already exists/);
  } finally {
    cleanup(service, dir);
  }
});
