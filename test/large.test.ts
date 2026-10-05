import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RevenueLedger } from "../src/ledger";
import { parseDate, formatDate } from "../src/date";

// ---------- 规模与限制 ----------
const N_ITEMS = 300_000;
const N_LONG_ITEMS = 240_000; // 服务期 3650 天
const N_REFUNDS = 600_000;
const TIME_LIMIT_MS = 60_000;
const RSS_LIMIT = 512 * 1024 * 1024;
const FILE_LIMIT = 512 * 1024 * 1024;

const W0 = parseDate("2026-01-01");
const W1 = parseDate("2055-12-31");
const WINDOW_DAYS = W1 - W0 + 1;

// ---------- 确定性伪随机 ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const itemId = (i: number): string => `item-${i}`;

// ---------- 紧凑测试数据（生成耗时不计入性能统计） ----------
interface DataSet {
  itemAmounts: bigint[];
  itemStarts: Int32Array;
  itemDays: Int32Array;
  refundItem: Int32Array;
  refundDay: Int32Array;
  refundAmount: bigint[];
}

function generate(): DataSet {
  const rnd = mulberry32(20261005);
  const itemAmounts: bigint[] = new Array(N_ITEMS);
  const itemStarts = new Int32Array(N_ITEMS);
  const itemDays = new Int32Array(N_ITEMS);
  for (let i = 0; i < N_ITEMS; i++) {
    const days = i < N_LONG_ITEMS ? 3650 : 1 + Math.floor(rnd() * 365);
    const start = W0 + Math.floor(rnd() * (WINDOW_DAYS - days));
    const magnitude = 6 + Math.floor(rnd() * 13); // 10^6 .. 10^18
    let amount = 10n ** BigInt(magnitude) + BigInt(Math.floor(rnd() * 1000));
    if (amount > 10n ** 18n) amount = 10n ** 18n;
    itemAmounts[i] = amount;
    itemStarts[i] = start;
    itemDays[i] = days;
  }

  // 每项目退款笔数 1/2/3 各三分之一，合计恰好 600k
  const counts = new Int32Array(N_ITEMS);
  const order = Array.from({ length: N_ITEMS }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let k = 0; k < N_ITEMS; k++) counts[order[k]] = (k % 3) + 1;

  const refundItem = new Int32Array(N_REFUNDS);
  const refundDay = new Int32Array(N_REFUNDS);
  const refundAmount: bigint[] = new Array(N_REFUNDS);
  let n = 0;
  for (let i = 0; i < N_ITEMS; i++) {
    const start = itemStarts[i];
    const days = itemDays[i];
    let remaining = itemAmounts[i];
    for (let j = 0; j < counts[i] && n < N_REFUNDS; j++) {
      if (remaining < 2n) break;
      const inService = rnd() < 0.7;
      let day: number;
      if (inService) {
        day = start + Math.floor(rnd() * days);
      } else {
        const postEnd = Math.min(start + days + 1 + Math.floor(rnd() * 1825), W1);
        day = start + days <= postEnd ? start + days + Math.floor(rnd() * (postEnd - start - days + 1)) : start + Math.floor(rnd() * days);
      }
      if (day > W1) day = start + Math.floor(rnd() * days);
      let amt = remaining / BigInt(2 + Math.floor(rnd() * 20));
      if (amt < 1n) amt = 1n;
      if (amt > remaining) amt = remaining;
      remaining -= amt;
      refundItem[n] = i;
      refundDay[n] = day;
      refundAmount[n] = amt;
      n++;
    }
  }
  // 若因余额不足少于 60 万，向随机项目补足 1 分退款
  while (n < N_REFUNDS) {
    const i = Math.floor(rnd() * N_ITEMS);
    refundItem[n] = i;
    refundDay[n] = itemStarts[i] + Math.floor(rnd() * itemDays[i]);
    refundAmount[n] = 1n;
    n++;
  }
  return { itemAmounts, itemStarts, itemDays, refundItem, refundDay, refundAmount };
}

/** 退款按项目归集的 CSR 结构，供独立核算抽查使用。 */
interface RefundCsr {
  offsets: Int32Array;
  days: Int32Array;
  amounts: bigint[];
}

function buildRefundCsr(data: DataSet): RefundCsr {
  const counts = new Int32Array(N_ITEMS + 1);
  for (let r = 0; r < N_REFUNDS; r++) counts[data.refundItem[r] + 1]++;
  for (let i = 1; i <= N_ITEMS; i++) counts[i] += counts[i - 1];
  const offsets = counts;
  const days = new Int32Array(N_REFUNDS);
  const amounts: bigint[] = new Array(N_REFUNDS);
  const cursor = offsets.slice(0, N_ITEMS);
  for (let r = 0; r < N_REFUNDS; r++) {
    const pos = cursor[data.refundItem[r]]++;
    days[pos] = data.refundDay[r];
    amounts[pos] = data.refundAmount[r];
  }
  return { offsets, days, amounts };
}

function refundedUpTo(csr: RefundCsr, item: number, day: number): bigint {
  let total = 0n;
  for (let p = csr.offsets[item]; p < csr.offsets[item + 1]; p++) {
    if (csr.days[p] <= day) total += csr.amounts[p];
  }
  return total;
}

function dbSize(p: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      total += fs.statSync(p + suffix).size;
    } catch {
      /* 文件不存在 */
    }
  }
  return total;
}

function peakRssBytes(): number {
  const raw = process.resourceUsage().maxRSS;
  // Node 在 POSIX（含 macOS）上以 KiB 返回，Windows 以字节返回
  return process.platform === "win32" ? raw : raw * 1024;
}

test("大规模：一次封至末日与逐日推进", { timeout: 600_000 }, () => {
  const data = generate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-large-"));
  const dbA = path.join(dir, "one-shot.db");
  const dbB = path.join(dir, "daily.db");
  const ITEM_BATCH = 30_000;
  const REFUND_BATCH = 30_000;

  const recordAllItems = (ledger: RevenueLedger): void => {
    for (let b = 0; b < N_ITEMS; b += ITEM_BATCH) {
      const items = [];
      for (let i = b; i < Math.min(b + ITEM_BATCH, N_ITEMS); i++) {
        items.push({
          id: itemId(i),
          amount: data.itemAmounts[i],
          startDate: formatDate(data.itemStarts[i]),
          endDate: formatDate(data.itemStarts[i] + data.itemDays[i]),
        });
      }
      ledger.recordItems(items);
    }
  };

  // ---------- 模式 A：全部录入后一次封至末日 ----------
  const tA0 = Date.now();
  const ledgerA = new RevenueLedger(dbA);
  recordAllItems(ledgerA);
  // 退款乱序、分批
  const refundOrder = Array.from({ length: N_REFUNDS }, (_, i) => i);
  const rnd = mulberry32(99);
  for (let i = refundOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [refundOrder[i], refundOrder[j]] = [refundOrder[j], refundOrder[i]];
  }
  for (let b = 0; b < N_REFUNDS; b += REFUND_BATCH) {
    const refunds = [];
    for (let k = b; k < Math.min(b + REFUND_BATCH, N_REFUNDS); k++) {
      const r = refundOrder[k];
      refunds.push({
        itemId: itemId(data.refundItem[r]),
        amount: data.refundAmount[r],
        effectiveDate: formatDate(data.refundDay[r]),
      });
    }
    ledgerA.recordRefunds(refunds);
  }
  ledgerA.advanceTo(formatDate(W1));
  const elapsedA = Date.now() - tA0;
  const reportA = ledgerA.exportRange(formatDate(W0), formatDate(W1));
  ledgerA.close();

  // ---------- 模式 B：逐日推进 + 分批交错录入未来退款 ----------
  const tB0 = Date.now();
  const ledgerB = new RevenueLedger(dbB);
  recordAllItems(ledgerB);
  // 将退款分配到 60 个录入批次：生效窗口减随机提前量，批内乱序
  const N_WINDOWS = 60;
  const windowLen = Math.ceil(WINDOW_DAYS / N_WINDOWS);
  const batches: number[][] = Array.from({ length: N_WINDOWS }, () => []);
  for (let r = 0; r < N_REFUNDS; r++) {
    const w = Math.min(N_WINDOWS - 1, Math.floor((data.refundDay[r] - W0) / windowLen));
    const lead = Math.floor(rnd() * 6);
    batches[Math.max(0, w - lead)].push(r);
  }
  for (const batch of batches) {
    for (let i = batch.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [batch[i], batch[j]] = [batch[j], batch[i]];
    }
  }
  for (let w = 0; w < N_WINDOWS; w++) {
    if (batches[w].length > 0) {
      const refunds = batches[w].map((r) => ({
        itemId: itemId(data.refundItem[r]),
        amount: data.refundAmount[r],
        effectiveDate: formatDate(data.refundDay[r]),
      }));
      ledgerB.recordRefunds(refunds);
    }
    const windowEnd = Math.min(W0 + (w + 1) * windowLen - 1, W1);
    for (let d = W0 + w * windowLen; d <= windowEnd; d++) {
      ledgerB.advanceTo(formatDate(d));
    }
  }
  const elapsedB = Date.now() - tB0;
  const reportB = ledgerB.exportRange(formatDate(W0), formatDate(W1));
  ledgerB.close();

  // ---------- 断言耗时 ----------
  console.log(`mode A (one-shot): ${elapsedA}ms, mode B (daily): ${elapsedB}ms`);
  assert.ok(elapsedA <= TIME_LIMIT_MS, `mode A elapsed ${elapsedA}ms > ${TIME_LIMIT_MS}ms`);
  assert.ok(elapsedB <= TIME_LIMIT_MS, `mode B elapsed ${elapsedB}ms > ${TIME_LIMIT_MS}ms`);

  // ---------- 比较完整日报 ----------
  assert.equal(reportA.days.length, WINDOW_DAYS);
  assert.equal(reportA.totalRevenue, reportB.totalRevenue, "两模式区间收入合计一致");
  for (let i = 0; i < WINDOW_DAYS; i++) {
    assert.equal(reportA.days[i].revenue, reportB.days[i].revenue, `revenue day ${reportA.days[i].date}`);
    assert.equal(reportA.days[i].deferred, reportB.days[i].deferred, `deferred day ${reportA.days[i].date}`);
  }

  // ---------- 抽查日期：独立逐笔计算核对 ----------
  const csr = buildRefundCsr(data);
  const recognizedAt = (i: number, d: number): bigint => {
    const net = data.itemAmounts[i] - refundedUpTo(csr, i, d);
    const k = Math.max(0, Math.min(data.itemDays[i], d - data.itemStarts[i] + 1));
    if (k === 0) return 0n;
    if (k === data.itemDays[i]) return net;
    return (net / BigInt(data.itemDays[i])) * BigInt(k);
  };
  const sampleDays = new Set<number>();
  while (sampleDays.size < 24) sampleDays.add(W0 + Math.floor(rnd() * WINDOW_DAYS));
  sampleDays.add(W0);
  sampleDays.add(W1);
  for (const d of sampleDays) {
    let revenue = 0n;
    let deferred = 0n;
    for (let i = 0; i < N_ITEMS; i++) {
      const cur = recognizedAt(i, d);
      const prev = recognizedAt(i, d - 1);
      revenue += cur - prev;
      const prepaid = d >= data.itemStarts[i] ? data.itemAmounts[i] : 0n;
      deferred += prepaid - refundedUpTo(csr, i, d) - cur;
    }
    const cell = reportA.days[d - W0];
    assert.equal(cell.revenue, revenue, `oracle revenue at ${cell.date}`);
    assert.equal(cell.deferred, deferred, `oracle deferred at ${cell.date}`);
  }

  // ---------- 断言资源占用 ----------
  const rss = peakRssBytes();
  const sizeA = dbSize(dbA);
  const sizeB = dbSize(dbB);
  console.log(`peak RSS: ${(rss / 1024 / 1024).toFixed(1)} MiB, db A: ${(sizeA / 1024 / 1024).toFixed(1)} MiB, db B: ${(sizeB / 1024 / 1024).toFixed(1)} MiB`);
  assert.ok(rss <= RSS_LIMIT, `peak RSS ${rss} > ${RSS_LIMIT}`);
  assert.ok(sizeA <= FILE_LIMIT, `db A size ${sizeA} > ${FILE_LIMIT}`);
  assert.ok(sizeB <= FILE_LIMIT, `db B size ${sizeB} > ${FILE_LIMIT}`);
});
