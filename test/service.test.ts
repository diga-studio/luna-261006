import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisposableDomainService, normalizeDomain } from "../dist/index.js";
import { RuleStore } from "../dist/store.js";
import type { CheckResult } from "../dist/index.js";

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ddc-test-"));
  return {
    path: join(dir, "rules.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 独立计算：用受理时修订的规则集在测试侧逐行重算，与库返回结果对照。 */
function referenceCheck(rules: string[], line: string): {
  disposable: boolean;
  matchedRule: string | null;
} {
  const normalizedRules = new Map<string, number>();
  for (const rule of rules) {
    const n = normalizeDomain(rule);
    normalizedRules.set(n, n.split(".").length);
  }
  const at = line.trim().lastIndexOf("@");
  const domain = normalizeDomain(at === -1 ? line.trim() : line.trim().slice(at + 1));
  const parts = domain.split(".");
  let best: string | null = null;
  let bestLabels = -1;
  for (let i = 0; i < parts.length; i += 1) {
    const suffix = parts.slice(i).join(".");
    const labels = normalizedRules.get(suffix);
    if (labels !== undefined && labels > bestLabels) {
      best = suffix;
      bestLabels = labels;
    }
  }
  return { disposable: best !== null, matchedRule: best };
}

test("同一名单跨越两次发布：批次内结果与受理时修订的独立计算一致", () => {
  const { path, cleanup } = tmpDb();
  try {
    const svc = new DisposableDomainService(path);
    assert.equal(svc.currentRevision(), 0);

    // 第一次发布：修订 1
    const rev1Rules = ["trash.test", "münchen.de", "faß.de", "junk.mail"];
    const imp1 = svc.beginImport(1);
    imp1.addChunk(rev1Rules);
    assert.equal(imp1.commit(), true);
    assert.equal(svc.currentRevision(), 1);

    // 名单受理：固定修订 1
    const batch = svc.acceptBatch();
    assert.equal(batch.revision, 1);

    // 批次进行期间完成两次发布：修订 2、修订 3（分段到达）
    const imp2 = svc.beginImport(2);
    imp2.addChunk(["trash.test", "newtrap.test"]);
    imp2.addChunk(["münchen.de."]); // 末尾根点
    assert.equal(imp2.commit(), true);
    const imp3 = svc.beginImport(3);
    imp3.addChunk(["third.test"]);
    assert.equal(imp3.commit(), true);
    assert.equal(svc.currentRevision(), 3);

    // 名单行：Unicode 与 Punycode 等价、末尾根点、伪后缀、重复输入
    const lines = [
      "user@trash.test",
      "a.trash.test",
      "deep.a.trash.test.",
      "nottrash.test",
      "user@nottrash.test",
      "user@münchen.de",
      "user@xn--mnchen-3ya.de",
      "x.münchen.de.",
      "faß.de",
      "fass.de",
      "junk.mail",
      "sub.junk.mail",
      "newtrap.test",
      "third.test",
      "user@trash.test", // 重复输入仍逐行返回
      "user@trash.test",
    ];
    const results: CheckResult[] = lines.map((line) => batch.checkLine(line));

    // 全部结果必须与受理时（修订 1）域名表的独立计算完全一致
    for (let i = 0; i < lines.length; i += 1) {
      const expected = referenceCheck(rev1Rules, lines[i]);
      assert.equal(results[i].input, lines[i]);
      assert.equal(results[i].revision, 1);
      assert.equal(results[i].disposable, expected.disposable, `line: ${lines[i]}`);
      assert.equal(results[i].matchedRule, expected.matchedRule, `line: ${lines[i]}`);
    }
    // 关键断言：修订 2/3 的新规则对老批次不可见
    assert.equal(results[12].disposable, false); // newtrap.test
    assert.equal(results[13].disposable, false); // third.test
    // Unicode ↔ Punycode 命中同一条规则
    assert.equal(results[5].matchedRule, "xn--mnchen-3ya.de");
    assert.equal(results[6].matchedRule, "xn--mnchen-3ya.de");
    // 伪后缀不命中
    assert.equal(results[3].disposable, false);
    // ß 与 ss 不等价
    assert.equal(results[8].disposable, true);
    assert.equal(results[9].disposable, false);

    // 新批次使用受理时的新修订（修订 3：整份替换，只剩 third.test）
    const batch2 = svc.acceptBatch();
    assert.equal(batch2.revision, 3);
    assert.equal(batch2.checkLine("third.test").disposable, true);
    assert.equal(batch2.checkLine("trash.test").disposable, false);
    assert.equal(batch2.checkLine("newtrap.test").disposable, false);

    // 老批次在新批次受理后仍读旧修订
    assert.equal(batch.checkLine("trash.test").disposable, true);

    batch.close();
    batch2.close();
    svc.close();
  } finally {
    cleanup();
  }
});

test("新修订先完成、旧修订后完成：当前修订始终是最大成功修订", () => {
  const { path, cleanup } = tmpDb();
  try {
    const svc = new DisposableDomainService(path);

    const imp10 = svc.beginImport(10);
    imp10.addChunk(["old.test"]);
    const imp20 = svc.beginImport(20);
    imp20.addChunk(["new.test"]);

    // 新修订先完成
    assert.equal(imp20.commit(), true);
    assert.equal(svc.currentRevision(), 20);
    // 旧修订后完成：不能回滚
    assert.equal(imp10.commit(), false);
    assert.equal(svc.currentRevision(), 20);

    const batch = svc.acceptBatch();
    assert.equal(batch.revision, 20);
    assert.equal(batch.checkLine("new.test").disposable, true);
    assert.equal(batch.checkLine("old.test").disposable, false);
    batch.close();
    svc.close();
  } finally {
    cleanup();
  }
});

test("任何批次都看不到半份新表：导入中的分段数据不可见", () => {
  const { path, cleanup } = tmpDb();
  try {
    const svc = new DisposableDomainService(path);
    const imp1 = svc.beginImport(1);
    imp1.addChunk(["stable.test"]);
    imp1.commit();

    // 修订 2 分段到达，尚未提交
    const imp2 = svc.beginImport(2);
    imp2.addChunk(["partial-a.test"]);

    const batch = svc.acceptBatch();
    assert.equal(batch.revision, 1);
    assert.equal(batch.checkLine("partial-a.test").disposable, false);
    assert.equal(batch.checkLine("stable.test").disposable, true);

    imp2.addChunk(["partial-b.test"]);
    // 提交前受理的批次依旧只看修订 1
    assert.equal(batch.checkLine("partial-b.test").disposable, false);
    assert.equal(imp2.commit(), true);

    // 提交后新批次看到完整的新表（两段都在）
    const batch2 = svc.acceptBatch();
    assert.equal(batch2.revision, 2);
    assert.equal(batch2.checkLine("partial-a.test").disposable, true);
    assert.equal(batch2.checkLine("partial-b.test").disposable, true);
    assert.equal(batch2.checkLine("stable.test").disposable, false);

    batch.close();
    batch2.close();
    svc.close();
  } finally {
    cleanup();
  }
});

test("取消批次：已交付结果不撤回，取消后不得再交付", () => {
  const { path, cleanup } = tmpDb();
  try {
    const svc = new DisposableDomainService(path);
    const imp = svc.beginImport(1);
    imp.addChunk(["trash.test"]);
    imp.commit();

    const batch = svc.acceptBatch();
    const delivered = batch.checkLine("trash.test");
    assert.equal(delivered.disposable, true);

    batch.cancel();
    assert.equal(batch.active, false);
    // 已交付结果保持有效（调用方仍持有）
    assert.equal(delivered.matchedRule, "trash.test");
    // 取消完成后不得再交付结果
    assert.throws(() => batch.checkLine("trash.test"));
    assert.throws(() => batch.close());
    svc.close();
  } finally {
    cleanup();
  }
});

test("修订回收：失效且无人使用的修订被回收，被占用的修订保持可读", () => {
  const { path, cleanup } = tmpDb();
  try {
    const svc = new DisposableDomainService(path);
    const imp1 = svc.beginImport(1);
    imp1.addChunk(["old.test"]);
    imp1.commit();

    const batch = svc.acceptBatch(); // 占用修订 1

    const imp2 = svc.beginImport(2);
    imp2.addChunk(["new.test"]);
    imp2.commit(); // 修订 1 失效，但仍被 batch 占用

    // 被占用的旧修订保持可读
    assert.equal(batch.checkLine("old.test").disposable, true);
    const probe = new RuleStore(path);
    assert.equal(probe.lookup(1, "old.test"), "old.test");
    probe.close();

    // 批次结束后旧修订无人使用，应回收
    batch.close();
    const probe2 = new RuleStore(path);
    assert.equal(probe2.lookup(1, "old.test"), null);
    assert.equal(probe2.lookup(2, "new.test"), "new.test");
    probe2.close();
    svc.close();
  } finally {
    cleanup();
  }
});

test("持久化：重新打开后当前修订与规则保留", () => {
  const { path, cleanup } = tmpDb();
  try {
    const svc = new DisposableDomainService(path);
    const imp = svc.beginImport(7);
    imp.addChunk(["persist.test"]);
    imp.commit();
    svc.close();

    const svc2 = new DisposableDomainService(path);
    assert.equal(svc2.currentRevision(), 7);
    const batch = svc2.acceptBatch();
    assert.equal(batch.checkLine("a.persist.test").disposable, true);
    batch.close();
    svc2.close();
  } finally {
    cleanup();
  }
});

test("最长标签匹配优先，归一化后重复规则视为一条", () => {
  const { path, cleanup } = tmpDb();
  try {
    const svc = new DisposableDomainService(path);
    const imp = svc.beginImport(1);
    imp.addChunk(["trash.test", "a.trash.test", "TRASH.test.", "trash.test"]);
    imp.commit();

    const batch = svc.acceptBatch();
    // 多条规则命中时返回标签最多的那条
    assert.equal(batch.checkLine("x.a.trash.test").matchedRule, "a.trash.test");
    assert.equal(batch.checkLine("b.trash.test").matchedRule, "trash.test");
    batch.close();
    svc.close();
  } finally {
    cleanup();
  }
});

test("导入校验：修订号必须唯一且为正整数；放弃导入不生效", () => {
  const { path, cleanup } = tmpDb();
  try {
    const svc = new DisposableDomainService(path);
    assert.throws(() => svc.beginImport(0));
    assert.throws(() => svc.beginImport(-3));
    assert.throws(() => svc.beginImport(1.5));

    const imp = svc.beginImport(4);
    imp.addChunk(["aborted.test"]);
    imp.abort();
    assert.equal(svc.currentRevision(), 0);
    assert.throws(() => imp.addChunk(["x.test"]));

    const impAgain = svc.beginImport(4); // 放弃后同号可重新导入
    impAgain.addChunk(["ok.test"]);
    assert.equal(impAgain.commit(), true);
    assert.throws(() => svc.beginImport(4)); // 已提交的修订号不能复用
    svc.close();
  } finally {
    cleanup();
  }
});
