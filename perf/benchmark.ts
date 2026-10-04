/**
 * 性能样例（10 万条目录 + 1000 条查询，阈值 0.80/0.80）：
 *   样例 A：地址高度重复、描述有区分度；
 *   样例 B：描述大量复用模板、地址有区分度。
 * 报告装入耗时、查询累计耗时、峰值内存；
 * 并对抽样查询做独立的逐对精确核对（长度预过滤 + 精确编辑距离，
 * 不经过索引逻辑），确认命中集合完全一致。
 */
import { performance } from "node:perf_hooks";
import { ListingDedupIndex, type ListingInput } from "../src/catalog.js";
import { toCodePoints, levenshtein } from "../src/levenshtein.js";

const CATALOG_SIZE = 100_000;
const QUERY_COUNT = 1_000;
const VERIFY_SAMPLE = 25;
const THRESHOLD = 0.8;

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const CITY = ["北京", "上海", "广州", "深圳", "杭州", "成都", "武汉", "西安", "南京", "重庆"];
const DISTRICT = ["朝阳", "海淀", "浦东", "天河", "滨江", "武侯", "江汉", "雁塔", "玄武", "渝北"];
const ROAD = ["建国", "复兴", "中山", "解放", "人民", "和平", "世纪", "滨江", "学府", "锦绣"];
const POI = ["万象城", "中心公园", "实验中学", "人民医院", "市民广场", "奥体中心"];
const WORD_A = [
  "南北", "东西", "前后", "左右", "上下", "内外", "动静", "干湿", "明暗", "冷暖",
];
const WORD_B = [
  "通透", "分离", "对流", "呼应", "衔接", "过渡", "分区", "错落", "延展", "围合",
];
const WORD_C = [
  "采光充足", "视野开阔", "安静宜居", "格局方正", "通风良好", "楼间距大", "日照时间长",
  "私密性好", "动线合理", "得房率高", "层高挑空", "转角飘窗", "双阳台", "落地窗",
];
const WORD_D = [
  "精装修", "毛坯交付", "家电齐全", "拎包入住", "首次出租", "随时看房", "业主急售",
  "满五唯一", "学区房", "电梯房", "物业负责", "绿化率高", "配套成熟", "车位充足",
];
const WORD_E = [
  "近地铁", "近商圈", "近学校", "近公园", "近医院", "近菜场", "近高铁站", "近图书馆",
];

function pick<T>(rnd: () => number, arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)]!;
}

/** 生成 40~96 码点的地址。 */
function makeAddress(rnd: () => number): string {
  let s =
    `${pick(rnd, CITY)}市${pick(rnd, DISTRICT)}区${pick(rnd, ROAD)}路` +
    `${1 + Math.floor(rnd() * 998)}号${pick(rnd, ROAD)}小区` +
    `${1 + Math.floor(rnd() * 30)}栋${1 + Math.floor(rnd() * 4)}单元` +
    `${1 + Math.floor(rnd() * 34)}0${1 + Math.floor(rnd() * 4)}室`;
  if (rnd() < 0.6) s += `(近${pick(rnd, POI)}${pick(rnd, ["地铁站", "商圈", "校区"])})`;
  if ([...s].length < 40) s += `${pick(rnd, DISTRICT)}街道${pick(rnd, ROAD)}社区`;
  return s;
}

/** 生成 160~256 码点的描述。 */
function makeDescription(rnd: () => number): string {
  const parts: string[] = [];
  let len = 0;
  const target = 160 + Math.floor(rnd() * 96);
  while (len < target) {
    const seg =
      `${pick(rnd, WORD_A)}${pick(rnd, WORD_B)}，${pick(rnd, WORD_C)}，` +
      `${1 + Math.floor(rnd() * 5)}室${1 + Math.floor(rnd() * 3)}厅` +
      `${70 + Math.floor(rnd() * 130)}平米，${pick(rnd, WORD_D)}，` +
      `${pick(rnd, WORD_E)}${1 + Math.floor(rnd() * 12)}号线，${pick(rnd, WORD_C)}。`;
    parts.push(seg);
    len += [...seg].length;
  }
  return parts.join("");
}

/** 对文本做少量码点级改写（替换/插入/删除），保持高相似度。 */
function mutate(rnd: () => number, text: string, edits: number): string {
  const chars = [...text];
  for (let e = 0; e < edits && chars.length > 0; e++) {
    const pos = Math.floor(rnd() * chars.length);
    const op = rnd();
    if (op < 0.5) chars[pos] = String.fromCodePoint(0x4e00 + Math.floor(rnd() * 2000));
    else if (op < 0.75) chars.splice(pos, 0, String(Math.floor(rnd() * 10)));
    else chars.splice(pos, 1);
  }
  return chars.join("");
}

interface Sample {
  name: string;
  catalog: ListingInput[];
  queries: ListingInput[];
}

/** 样例 A：地址高度重复（约 200 个基底派生），描述逐条生成有区分度。 */
function buildSampleA(): Sample {
  const rnd = makeRng(0xa110c);
  const baseAddresses = Array.from({ length: 200 }, () => makeAddress(rnd));
  const catalog: ListingInput[] = [];
  const queries: ListingInput[] = [];
  // 先放 planted 重复组：组内地址、描述都互为高相似
  const groupCount = 1200;
  const groupSize = 6;
  for (let g = 0; g < groupCount; g++) {
    const addr = mutate(rnd, pick(rnd, baseAddresses), 2);
    const desc = makeDescription(rnd);
    for (let m = 0; m < groupSize; m++) {
      catalog.push({
        id: `A-g${g}-m${m}`,
        address: mutate(rnd, addr, 2),
        description: mutate(rnd, desc, 4),
      });
    }
    if (g < QUERY_COUNT) {
      queries.push({
        id: `qA-${g}`,
        address: mutate(rnd, addr, 2),
        description: mutate(rnd, desc, 4),
      });
    }
  }
  // 其余记录：地址取自基底（高度重复），描述随机（有区分度）
  let i = 0;
  while (catalog.length < CATALOG_SIZE) {
    catalog.push({
      id: `A-r${i++}`,
      address: mutate(rnd, pick(rnd, baseAddresses), Math.floor(rnd() * 3)),
      description: makeDescription(rnd),
    });
  }
  return { name: "样例A-地址高度重复/描述有区分度", catalog, queries };
}

/** 样例 B：描述大量复用模板（约 60 个模板），地址逐条生成有区分度。 */
function buildSampleB(): Sample {
  const rnd = makeRng(0xb220c);
  const templates = Array.from({ length: 60 }, () => makeDescription(rnd));
  const catalog: ListingInput[] = [];
  const queries: ListingInput[] = [];
  const groupCount = 1200;
  const groupSize = 6;
  for (let g = 0; g < groupCount; g++) {
    const addr = makeAddress(rnd);
    const desc = mutate(rnd, pick(rnd, templates), 6);
    for (let m = 0; m < groupSize; m++) {
      catalog.push({
        id: `B-g${g}-m${m}`,
        address: mutate(rnd, addr, 2),
        description: mutate(rnd, desc, 4),
      });
    }
    if (g < QUERY_COUNT) {
      queries.push({
        id: `qB-${g}`,
        address: mutate(rnd, addr, 2),
        description: mutate(rnd, desc, 4),
      });
    }
  }
  let i = 0;
  while (catalog.length < CATALOG_SIZE) {
    catalog.push({
      id: `B-r${i++}`,
      address: makeAddress(rnd),
      description: mutate(rnd, pick(rnd, templates), Math.floor(rnd() * 7)),
    });
  }
  return { name: "样例B-描述复用模板/地址有区分度", catalog, queries };
}

function medianLength(texts: string[]): number {
  const lens = texts.map((t) => [...t].length).sort((a, b) => a - b);
  return lens[Math.floor(lens.length / 2)]!;
}

/** 独立逐对核对：长度预过滤 + 精确编辑距离（不经过索引）。 */
function bruteForceIds(catalog: ListingInput[], query: ListingInput, tScaled: number): string[] {
  const qa = toCodePoints(query.address);
  const qd = toCodePoints(query.description);
  const hits: string[] = [];
  for (const rec of catalog) {
    const ra = toCodePoints(rec.address);
    const maxA = Math.max(qa.length, ra.length);
    const kA = Math.floor(((100 - tScaled) * maxA) / 100);
    if (Math.abs(qa.length - ra.length) > kA) continue;
    if (maxA > 0 && levenshtein(qa, ra, kA) > kA) continue;
    const rd = toCodePoints(rec.description);
    const maxD = Math.max(qd.length, rd.length);
    const kD = Math.floor(((100 - tScaled) * maxD) / 100);
    if (Math.abs(qd.length - rd.length) > kD) continue;
    if (maxD > 0 && levenshtein(qd, rd, kD) > kD) continue;
    hits.push(rec.id);
  }
  return hits;
}

function peakRssMiB(): number {
  // libuv 在各平台统一以 KB 报告 maxRSS
  return (process.resourceUsage().maxRSS * 1024) / 1048576;
}

function rssMiB(): number {
  return process.memoryUsage().rss / 1048576;
}

function runSample(sample: Sample): void {
  console.log(`\n=== ${sample.name} ===`);
  const medAddr = medianLength(sample.catalog.map((r) => r.address));
  const medDesc = medianLength(sample.catalog.map((r) => r.description));
  console.log(`目录 ${sample.catalog.length} 条，地址中位长度 ${medAddr} 码点，描述中位长度 ${medDesc} 码点`);

  globalThis.gc?.();
  const rssBefore = rssMiB();
  const t0 = performance.now();
  const index = new ListingDedupIndex(sample.catalog);
  const loadMs = performance.now() - t0;
  console.log(`装入耗时: ${loadMs.toFixed(0)} ms（要求 ≤ 60000 ms）`);

  let maxHits = 0;
  let totalHits = 0;
  const t1 = performance.now();
  const allResults: string[][] = [];
  for (const q of sample.queries) {
    const hits = index.findDuplicates(q, THRESHOLD, THRESHOLD);
    totalHits += hits.length;
    if (hits.length > maxHits) maxHits = hits.length;
    allResults.push(hits.map((c) => c.id));
  }
  const queryMs = performance.now() - t1;
  console.log(
    `查询 ${sample.queries.length} 条累计耗时: ${queryMs.toFixed(0)} ms（要求 ≤ 30000 ms），` +
      `平均 ${(queryMs / sample.queries.length).toFixed(2)} ms/条`,
  );
  console.log(`命中：平均 ${(totalHits / sample.queries.length).toFixed(1)} 条/查询，最大 ${maxHits} 条（要求 ≤ 50）`);

  // 独立核对：抽样查询做逐对精确计算，命中集合必须完全一致
  const rnd = makeRng(0x5eed1);
  let checked = 0;
  for (let s = 0; s < VERIFY_SAMPLE; s++) {
    const qi = Math.floor(rnd() * sample.queries.length);
    const expected = bruteForceIds(sample.catalog, sample.queries[qi]!, 80).sort();
    const actual = [...allResults[qi]!].sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      console.error(`核对失败：查询 ${sample.queries[qi]!.id}`);
      console.error(`  预期 ${expected.length} 条: ${expected.slice(0, 5).join(",")}...`);
      console.error(`  实际 ${actual.length} 条: ${actual.slice(0, 5).join(",")}...`);
      process.exitCode = 1;
      return;
    }
    checked++;
  }
  console.log(`独立核对：${checked} 条抽样查询与逐对精确计算完全一致`);

  console.log(`峰值内存(maxRSS): ${peakRssMiB().toFixed(0)} MiB（要求 ≤ 512 MiB），装入前 RSS ${rssBefore.toFixed(0)} MiB，当前 RSS ${rssMiB().toFixed(0)} MiB`);
}

// 每个样例在独立进程中运行，峰值内存互不干扰。
// 不带参数时派生两个子进程分别执行。
const which = process.argv[2];
if (which === "A") {
  runSample(buildSampleA());
} else if (which === "B") {
  runSample(buildSampleB());
} else {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const self = fileURLToPath(import.meta.url);
  for (const s of ["A", "B"]) {
    try {
      const out = execFileSync(process.execPath, ["--expose-gc", self, s], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
      process.stdout.write(out);
    } catch {
      process.exitCode = 1;
    }
  }
}
