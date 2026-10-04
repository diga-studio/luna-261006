/**
 * 性能样例：10 万条目录、两类极端分布。
 * 样例 A：地址高度重复（约 50 条记录共享同一地址），描述随机生成、有区分度。
 * 样例 B：描述大量复用模板（50 个模板），地址逐条随机、有区分度。
 * 预期命中由生成器按构造给出，并对前若干条查询用逐对精确计算独立核对。
 */
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadCatalog } from "../src/catalog.js";
import { boundedDistanceCP, codePoints } from "../src/levenshtein.js";
import type { ListingRecord } from "../src/types.js";

const CATALOG_SIZE = 100_000;
const QUERY_COUNT = 1_000;
const ADDR_T = 0.8;
const DESC_T = 0.8;
const BRUTE_CHECK_QUERIES = 10;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADDR_CHARS = "北京市上海广州深圳朝阳区建国路南京西街道号院小区栋单元室珠江新城天河";
const DESC_CHARS = "精装修南北通透采光好拎包入住满五唯一学区房地铁口电梯高层视野开阔随时看房";
const ADDR_POOL = [...ADDR_CHARS];
const DESC_POOL = [...DESC_CHARS];

/** 由字符池构造片段词表（2~6 码点），用于以拼接方式低垃圾地造串。 */
function buildFrags(rnd: () => number, pool: string[], count: number): string[] {
  const frags: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = 2 + Math.floor(rnd() * 5);
    let f = "";
    for (let j = 0; j < len; j++) f += pool[Math.floor(rnd() * pool.length)];
    frags.push(f);
  }
  return frags;
}

/** 随机拼接若干片段，总码点长度落在 [minLen, maxLen]。片段均为 BMP，length 即码点数。 */
function randConcat(
  rnd: () => number,
  frags: string[],
  minLen: number,
  maxLen: number,
): string {
  const target = minLen + Math.floor(rnd() * (maxLen - minLen + 1));
  const parts: string[] = [];
  let len = 0;
  while (len < target) {
    const f = frags[Math.floor(rnd() * frags.length)]!;
    parts.push(f);
    len += f.length;
  }
  return parts.join("");
}

/** 码点长度（不分配中间数组）。 */
function cpLen(text: string): number {
  let n = 0;
  for (const _ch of text) n++;
  return n;
}

const HAS_SURROGATE = /[\uD800-\uDFFF]/;

/** 对文本做 times 次随机编辑（替换/插入/删除），按码点处理；BMP 走切片避免临时数组。 */
function mutate(rnd: () => number, text: string, pool: string[], times: number): string {
  if (!HAS_SURROGATE.test(text)) {
    let s = text;
    for (let t = 0; t < times; t++) {
      const op = rnd();
      const i = Math.floor(rnd() * s.length);
      const ch = pool[Math.floor(rnd() * pool.length)]!;
      if (op < 0.5) s = s.slice(0, i) + ch + s.slice(i + 1);
      else if (op < 0.75 && s.length > 1) s = s.slice(0, i) + s.slice(i + 1);
      else s = s.slice(0, i) + ch + s.slice(i);
    }
    return s;
  }
  const cps = codePoints(text);
  for (let t = 0; t < times; t++) {
    const op = rnd();
    const i = Math.floor(rnd() * cps.length);
    const ch = pool[Math.floor(rnd() * pool.length)]!;
    if (op < 0.5) cps[i] = ch;
    else if (op < 0.75 && cps.length > 1) cps.splice(i, 1);
    else cps.splice(i, 0, ch);
  }
  return cps.join("");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

interface QueryCase {
  query: ListingRecord;
  expected: string[];
}

interface Sample {
  name: string;
  records: ListingRecord[];
  queries: QueryCase[];
}

/** 样例 A：地址高度重复、描述有区分度。预期命中恰为被变种的源记录本身。 */
function buildSampleA(): Sample {
  const rnd = mulberry32(20261004);
  const addrFrags = buildFrags(rnd, ADDR_POOL, 400);
  const descFrags = buildFrags(rnd, DESC_POOL, 600);
  const baseAddrCount = 2_000; // 每个地址约 50 条记录共享
  const baseAddrs: string[] = [];
  for (let i = 0; i < baseAddrCount; i++) {
    baseAddrs.push(randConcat(rnd, addrFrags, 40, 79));
  }
  const records: ListingRecord[] = [];
  for (let i = 0; i < CATALOG_SIZE; i++) {
    records.push({
      id: `A${i}`,
      address: baseAddrs[i % baseAddrCount]!,
      description: randConcat(rnd, descFrags, 160, 239),
    });
  }
  const queries: QueryCase[] = [];
  for (let qi = 0; qi < QUERY_COUNT; qi++) {
    const src = records[Math.floor(rnd() * records.length)]!;
    queries.push({
      query: {
        id: `q${qi}`,
        address: mutate(rnd, src.address, ADDR_POOL, 1 + Math.floor(rnd() * 3)),
        description: mutate(rnd, src.description, DESC_POOL, 1 + Math.floor(rnd() * 3)),
      },
      expected: [src.id],
    });
  }
  return { name: "A-地址高度重复", records, queries };
}

/** 样例 B：描述复用模板、地址有区分度。预期命中为构造出的近重复簇。 */
function buildSampleB(): Sample {
  const rnd = mulberry32(20261005);
  const addrFrags = buildFrags(rnd, ADDR_POOL, 400);
  const descFrags = buildFrags(rnd, DESC_POOL, 600);
  const templateCount = 50;
  const templates: string[] = [];
  for (let i = 0; i < templateCount; i++) {
    templates.push(randConcat(rnd, descFrags, 160, 239));
  }
  const records: ListingRecord[] = [];
  for (let i = 0; i < CATALOG_SIZE; i++) {
    records.push({
      id: `B${i}`,
      address: randConcat(rnd, addrFrags, 40, 79),
      // 模板加少量扰动，保证同模板记录描述高度相似
      description: mutate(rnd, templates[i % templateCount]!, DESC_POOL, Math.floor(rnd() * 3)),
    });
  }
  // 构造近重复簇：对 2000 条基记录各种植 1~3 条双向都达标的近重复
  const clusterOf = new Map<number, number[]>();
  let nextSlot = CATALOG_SIZE;
  const extra: ListingRecord[] = [];
  const clusterBases = 2_000;
  // 基记录不放回抽样，避免两个簇共用同一基记录
  const baseIdxPool = new Set<number>();
  while (baseIdxPool.size < clusterBases) {
    baseIdxPool.add(Math.floor(rnd() * CATALOG_SIZE));
  }
  for (const baseIdx of baseIdxPool) {
    const base = records[baseIdx]!;
    const members = [baseIdx];
    const dupCount = 1 + Math.floor(rnd() * 3);
    for (let d = 0; d < dupCount; d++) {
      const dup: ListingRecord = {
        id: `B${nextSlot}`,
        address: mutate(rnd, base.address, ADDR_POOL, 1 + Math.floor(rnd() * 3)),
        description: mutate(rnd, base.description, DESC_POOL, 1 + Math.floor(rnd() * 3)),
      };
      extra.push(dup);
      members.push(nextSlot);
      nextSlot++;
    }
    clusterOf.set(baseIdx, members);
  }
  const all = records.concat(extra);
  const queries: QueryCase[] = [];
  const bases = [...clusterOf.keys()];
  for (let qi = 0; qi < QUERY_COUNT; qi++) {
    const baseIdx = bases[Math.floor(rnd() * bases.length)]!;
    const base = all[baseIdx]!;
    const expected = clusterOf
      .get(baseIdx)!
      .map((i) => all[i]!.id)
      .sort();
    queries.push({
      query: {
        id: `q${qi}`,
        address: mutate(rnd, base.address, ADDR_POOL, 1 + Math.floor(rnd() * 3)),
        description: mutate(rnd, base.description, DESC_POOL, 1 + Math.floor(rnd() * 3)),
      },
      expected,
    });
  }
  return { name: "B-描述模板复用", records: all, queries };
}

/** 独立核对：逐对精确判定（整数阈值比较），不经过任何索引与计数过滤。 */
function bruteForceHits(
  records: readonly ListingRecord[],
  query: ListingRecord,
  addrTP: number,
  descTP: number,
): string[] {
  const qAddr = codePoints(query.address);
  const qDesc = codePoints(query.description);
  const hits: string[] = [];
  for (const rec of records) {
    if (
      fieldHit(qAddr, codePoints(rec.address), addrTP) &&
      fieldHit(qDesc, codePoints(rec.description), descTP)
    ) {
      hits.push(rec.id);
    }
  }
  return hits.sort();
}

function fieldHit(a: readonly string[], b: readonly string[], tPercent: number): boolean {
  const m = Math.max(a.length, b.length);
  const k = Math.floor(((100 - tPercent) * m) / 100);
  return boundedDistanceCP(a, b, k) <= k;
}

/** 驻留内存：V8 堆内对象 + 外部（TypedArray 后备）内存，即进程实际持有的内存。 */
function retainedMiB(): number {
  const mu = process.memoryUsage();
  return (mu.heapUsed + mu.external) / 1024 / 1024;
}

interface MemPeak {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
}

function startMemSampler(): { stop: () => Promise<MemPeak> } {
  const workerPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "memSampler.js",
  );
  const worker = new Worker(workerPath);
  return {
    stop: () =>
      new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.postMessage("stop");
      }),
  };
}

async function runSample(sample: Sample): Promise<void> {
  const { name, records, queries } = sample;
  const addrLens = records.map((r) => cpLen(r.address));
  const descLens = records.map((r) => cpLen(r.description));
  const addrMed = median(addrLens);
  const descMed = median(descLens);
  const addrMax = Math.max(...addrLens);
  const descMax = Math.max(...descLens);
  console.log(`\n=== 样例 ${name} ===`);
  console.log(
    `记录数=${records.length} 地址中位/最长=${addrMed}/${addrMax} 码点 描述中位/最长=${descMed}/${descMax} 码点`,
  );
  if (addrMed < 40 || descMed < 160) throw new Error("样例长度不满足要求");
  if (addrMax > 96 || descMax > 256) throw new Error("样例长度超过上限");

  global.gc?.();
  const retainedBefore = retainedMiB();
  const sampler = startMemSampler();
  const t0 = performance.now();
  const catalog = loadCatalog(records);
  const loadMs = performance.now() - t0;
  global.gc?.();
  const retainedAfterLoad = retainedMiB();

  let queryMs = 0;
  let totalHits = 0;
  let maxHits = 0;
  const mismatches: string[] = [];
  for (const qc of queries) {
    const q0 = performance.now();
    const got = catalog.findDuplicates(qc.query, ADDR_T, DESC_T);
    queryMs += performance.now() - q0;
    totalHits += got.length;
    maxHits = Math.max(maxHits, got.length);
    const gotSorted = [...got].sort();
    if (JSON.stringify(gotSorted) !== JSON.stringify(qc.expected)) {
      mismatches.push(
        `${qc.query.id}: got=${JSON.stringify(gotSorted)} want=${JSON.stringify(qc.expected)}`,
      );
    }
  }
  global.gc?.();
  const retainedAfterQuery = retainedMiB();
  const peak = await sampler.stop();

  // 独立核对：前若干条查询做全目录逐对精确计算
  let bruteOk = 0;
  for (let i = 0; i < Math.min(BRUTE_CHECK_QUERIES, queries.length); i++) {
    const qc = queries[i]!;
    const bf = bruteForceHits(records, qc.query, ADDR_T * 100, DESC_T * 100);
    const got = [...catalog.findDuplicates(qc.query, ADDR_T, DESC_T)].sort();
    if (JSON.stringify(got) !== JSON.stringify(bf)) {
      mismatches.push(`brute ${qc.query.id}: got=${JSON.stringify(got)} brute=${JSON.stringify(bf)}`);
    } else {
      bruteOk++;
    }
  }

  console.log(`装入耗时=${loadMs.toFixed(0)}ms`);
  console.log(
    `查询 ${queries.length} 条累计=${queryMs.toFixed(0)}ms（均值 ${(queryMs / queries.length).toFixed(2)}ms/条）`,
  );
  const mib = 1024 * 1024;
  const peakRetained = Math.max(retainedBefore, retainedAfterLoad, retainedAfterQuery);
  console.log(
    `驻留内存(heapUsed+external)：装入前=${retainedBefore.toFixed(0)} 装入后=${retainedAfterLoad.toFixed(0)} ` +
      `查询后=${retainedAfterQuery.toFixed(0)}MiB，峰值=${peakRetained.toFixed(0)}MiB`,
  );
  console.log(
    `（参考）进程 rss 峰值=${(peak.rss / mib).toFixed(0)}MiB；macOS 的 rss 含可回收的 MADV_FREE 页，会高于驻留值`,
  );
  if (peakRetained > 512) throw new Error("峰值驻留内存超过 512MiB");
  console.log(
    `命中：总=${totalHits} 单条最大=${maxHits}；构造预期校验=${mismatches.length === 0 ? "全部一致" : "不一致"}；逐对独立核对 ${bruteOk}/${Math.min(BRUTE_CHECK_QUERIES, queries.length)} 一致`,
  );
  if (loadMs > 60_000) throw new Error("装入超时");
  if (queryMs > 30_000) throw new Error("查询累计超时");
  if (maxHits > 50) throw new Error("单条查询命中超过 50");
  if (mismatches.length > 0) {
    console.error(mismatches.slice(0, 5).join("\n"));
    throw new Error("命中结果与预期不一致");
  }
}

const which = process.argv[2];
const main = async () => {
  if (which === undefined || which === "a") await runSample(buildSampleA());
  if (which === undefined || which === "b") await runSample(buildSampleB());
  console.log("\n性能样例全部通过");
};
await main();
