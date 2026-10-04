import { toCodePoints, buildMyersPattern, myersDistance, type MyersPattern } from "./levenshtein.js";

/** 一条房源记录（输入与目录内保存的字段）。 */
export interface ListingInput {
  /** 唯一记录标识。 */
  readonly id: string;
  /** 已清洗的完整地址（已完成 Unicode NFC 规范化）。 */
  readonly address: string;
  /** 描述文本（已完成 Unicode NFC 规范化）。 */
  readonly description: string;
}

/** 一条重复候选。 */
export interface DuplicateCandidate {
  readonly id: string;
  readonly address: string;
  readonly description: string;
  readonly addressSimilarity: number;
  readonly descriptionSimilarity: number;
}

/** 阈值合法范围：[0.70, 1.00]，最多两位小数。 */
export const MIN_THRESHOLD = 0.7;
export const MAX_THRESHOLD = 1.0;

/**
 * 校验阈值合法性，非法时抛 RangeError。
 * 合法时返回放大 100 倍的整数（70..100），供整数运算避免浮点误差。
 */
export function validateThreshold(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${name} 必须是有限数值，收到: ${String(value)}`);
  }
  const scaled = Math.round(value * 100);
  if (
    scaled < MIN_THRESHOLD * 100 ||
    scaled > MAX_THRESHOLD * 100 ||
    Math.abs(value - scaled / 100) > 1e-9
  ) {
    throw new RangeError(
      `${name} 必须在 [0.70, 1.00] 内且最多两位小数，收到: ${String(value)}`,
    );
  }
  return scaled;
}

/** 允许的最大编辑距离：floor((1 - t) * maxLen)，用整数运算避免浮点误差。 */
function maxEdits(thresholdScaled: number, maxLen: number): number {
  return Math.floor(((100 - thresholdScaled) * maxLen) / 100);
}

const BUCKET_BITS = 20;
const BUCKET_COUNT = 1 << BUCKET_BITS;
const BUCKET_MASK = BUCKET_COUNT - 1;

/** q-gram 哈希（FNV-1a 32bit），冲突只会带来少量误报，不影响正确性。 */
function gramHash(points: Uint32Array, start: number, q: number): number {
  let h = 0x811c9dc5;
  for (let i = start; i < start + q; i++) {
    h = Math.imul(h ^ points[i]!, 0x01000193);
  }
  return (h >>> 0) & BUCKET_MASK;
}

/**
 * 单字段的 q-gram 倒排索引：桶 -> 记录序号列表。
 * 采用计数排序式两遍构建，内存为扁平数组。
 */
class FieldIndex {
  readonly q: number;
  readonly offsets: Uint32Array; // BUCKET_COUNT + 1，前缀和
  readonly postings: Uint32Array; // 记录序号，按桶排列

  constructor(texts: string[], q: number) {
    this.q = q;
    const n = texts.length;
    const counts = new Uint32Array(BUCKET_COUNT);
    // 第一遍：统计每个桶的 gram 数
    for (let i = 0; i < n; i++) {
      const pts = toCodePoints(texts[i]!);
      const grams = pts.length - q + 1;
      for (let g = 0; g < grams; g++) {
        counts[gramHash(pts, g, q)]!++;
      }
    }
    const offsets = new Uint32Array(BUCKET_COUNT + 1);
    for (let b = 0; b < BUCKET_COUNT; b++) {
      offsets[b + 1] = offsets[b]! + counts[b]!;
    }
    const postings = new Uint32Array(offsets[BUCKET_COUNT]!);
    // 第二遍：重新计算码点并填充记录序号（cursor 复用 counts），
    // 不在堆上同时保留全部码点数组，降低峰值内存。
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const pts = toCodePoints(texts[i]!);
      const grams = pts.length - q + 1;
      for (let g = 0; g < grams; g++) {
        const bucket = gramHash(pts, g, q);
        postings[offsets[bucket]! + counts[bucket]!++] = i;
      }
    }
    this.offsets = offsets;
    this.postings = postings;
  }

  /** 某个桶的 posting 列表长度。 */
  postingLength(bucket: number): number {
    return this.offsets[bucket + 1]! - this.offsets[bucket]!;
  }
}

/** 统计查询文本的 q-gram：桶号 -> 该桶在查询中的 gram 出现次数。 */
function queryGramBuckets(points: Uint32Array, q: number): Map<number, number> {
  const map = new Map<number, number>();
  const grams = points.length - q + 1;
  for (let g = 0; g < grams; g++) {
    const bucket = gramHash(points, g, q);
    map.set(bucket, (map.get(bucket) ?? 0) + 1);
  }
  return map;
}

/**
 * 进程内房源目录与重复候选检索。
 * 目录装入后不再修改；查询不改动目录。
 */
export class ListingDedupIndex {
  private readonly ids: string[];
  private readonly addresses: string[];
  private readonly descriptions: string[];
  private readonly addrLens: Uint32Array;
  private readonly descLens: Uint32Array;
  private readonly addrIndex: FieldIndex;
  private readonly descIndex: FieldIndex;
  // 查询用的可复用缓冲（本模块只承诺单进程串行调用）
  private readonly counts: Int32Array;
  private readonly touched: Int32Array;

  constructor(listings: Iterable<ListingInput>) {
    const ids: string[] = [];
    const addresses: string[] = [];
    const descriptions: string[] = [];
    for (const item of listings) {
      ids.push(item.id);
      addresses.push(item.address);
      descriptions.push(item.description);
    }
    this.ids = ids;
    this.addresses = addresses;
    this.descriptions = descriptions;
    const n = ids.length;
    this.addrLens = new Uint32Array(n);
    this.descLens = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      this.addrLens[i] = toCodePoints(addresses[i]!).length;
      this.descLens[i] = toCodePoints(descriptions[i]!).length;
    }
    this.addrIndex = new FieldIndex(addresses, 2);
    this.descIndex = new FieldIndex(descriptions, 3);
    this.counts = new Int32Array(n);
    this.touched = new Int32Array(n);
  }

  /** 目录中的记录数。 */
  get size(): number {
    return this.ids.length;
  }

  /**
   * 查找目录中地址与描述相似度均达到各自阈值的全部记录。
   * 阈值恰好相等也算命中；判定基于整数运算，不做四舍五入。
   * 结果按目录装入顺序返回。
   */
  findDuplicates(
    query: ListingInput,
    addressThreshold: number,
    descriptionThreshold: number,
  ): DuplicateCandidate[] {
    const taScaled = validateThreshold(addressThreshold, "addressThreshold");
    const tdScaled = validateThreshold(descriptionThreshold, "descriptionThreshold");
    const qa = toCodePoints(query.address);
    const qd = toCodePoints(query.description);

    // 选择用哪个字段的索引做预筛：估计计数代价（各桶 posting 长度之和），取较小者。
    // 某字段查询文本太短没有 q-gram 时，该字段无法走索引。
    const addrGrams = qa.length >= this.addrIndex.q ? queryGramBuckets(qa, this.addrIndex.q) : null;
    const descGrams = qd.length >= this.descIndex.q ? queryGramBuckets(qd, this.descIndex.q) : null;

    let estAddr = Infinity;
    if (addrGrams !== null) {
      estAddr = 0;
      for (const bucket of addrGrams.keys()) estAddr += this.addrIndex.postingLength(bucket);
    }
    let estDesc = Infinity;
    if (descGrams !== null) {
      estDesc = 0;
      for (const bucket of descGrams.keys()) estDesc += this.descIndex.postingLength(bucket);
    }

    let candidateIds: number[];
    if (estAddr === Infinity && estDesc === Infinity) {
      // 两个字段都太短，退化为全量扫描（小文本，验证本身很快）。
      candidateIds = this.scanAll();
    } else if (estAddr <= estDesc) {
      candidateIds = this.prefilter(this.addrIndex, addrGrams!, qa.length, this.addrLens, taScaled);
    } else {
      candidateIds = this.prefilter(this.descIndex, descGrams!, qd.length, this.descLens, tdScaled);
    }

    // 对预筛通过的记录做两个字段的精确验证（Myers pattern 每查询只预处理一次）。
    const addrPattern = buildMyersPattern(qa);
    const descPattern = buildMyersPattern(qd);
    const result: DuplicateCandidate[] = [];
    for (const rec of candidateIds) {
      const cand = this.verify(
        rec, qa, qd, taScaled, tdScaled, addrGrams, descGrams, addrPattern, descPattern,
      );
      if (cand !== null) result.push(cand);
    }
    return result;
  }

  /** 全量扫描（仅用于查询文本过短的退化情形）。 */
  private scanAll(): number[] {
    const all: number[] = new Array(this.ids.length);
    for (let i = 0; i < all.length; i++) all[i] = i;
    return all;
  }

  /**
   * q-gram 计数过滤：编辑距离 <= k 的两串，共有 q-gram 多重计数
   * 至少为 maxLen - q + 1 - k*q。只可能误报、不会漏报。
   */
  private prefilter(
    index: FieldIndex,
    gramMap: Map<number, number>,
    queryLen: number,
    recordLens: Uint32Array,
    thresholdScaled: number,
  ): number[] {
    const counts = this.counts;
    const touched = this.touched;
    let touchedCount = 0;
    for (const [bucket, weight] of gramMap) {
      const start = index.offsets[bucket]!;
      const end = index.offsets[bucket + 1]!;
      for (let p = start; p < end; p++) {
        const rec = index.postings[p]!;
        if (counts[rec] === 0) touched[touchedCount++] = rec;
        counts[rec] = counts[rec]! + weight;
      }
    }
    const q = index.q;
    const candidates: number[] = [];
    for (let t = 0; t < touchedCount; t++) {
      const rec = touched[t]!;
      const count = counts[rec]!;
      counts[rec] = 0; // 复位，供下次查询复用
      const recLen = recordLens[rec]!;
      const maxLen = Math.max(queryLen, recLen);
      const k = maxEdits(thresholdScaled, maxLen);
      if (Math.abs(queryLen - recLen) > k) continue; // 长度预过滤
      const required = maxLen - q + 1 - k * q;
      if (required > 0 && count < required) continue; // q-gram 计数过滤
      candidates.push(rec);
    }
    return candidates;
  }

  /** 对单条记录做两个字段的精确阈值验证，通过则构造候选。 */
  private verify(
    rec: number,
    qa: Uint32Array,
    qd: Uint32Array,
    taScaled: number,
    tdScaled: number,
    addrGrams: Map<number, number> | null,
    descGrams: Map<number, number> | null,
    addrPattern: MyersPattern,
    descPattern: MyersPattern,
  ): DuplicateCandidate | null {
    const addrPts = toCodePoints(this.addresses[rec]!);
    const maxAddrLen = Math.max(qa.length, addrPts.length);
    const kAddr = maxEdits(taScaled, maxAddrLen);
    if (!this.gramFilterPasses(qa, addrPts, kAddr, this.addrIndex.q, addrGrams)) return null;
    const edAddr = myersDistance(addrPattern, addrPts);
    if (edAddr > kAddr) return null;

    const descPts = toCodePoints(this.descriptions[rec]!);
    const maxDescLen = Math.max(qd.length, descPts.length);
    const kDesc = maxEdits(tdScaled, maxDescLen);
    if (!this.gramFilterPasses(qd, descPts, kDesc, this.descIndex.q, descGrams)) return null;
    const edDesc = myersDistance(descPattern, descPts);
    if (edDesc > kDesc) return null;

    return {
      id: this.ids[rec]!,
      address: this.addresses[rec]!,
      description: this.descriptions[rec]!,
      addressSimilarity: maxAddrLen === 0 ? 1 : 1 - edAddr / maxAddrLen,
      descriptionSimilarity: maxDescLen === 0 ? 1 : 1 - edDesc / maxDescLen,
    };
  }

  /**
   * 逐候选的 q-gram 复核：真实共有 q-gram 数 < required 时可直接排除，
   * 避免昂贵的编辑距离计算。只可能误放、不会误杀。
   */
  private gramFilterPasses(
    queryPts: Uint32Array,
    recordPts: Uint32Array,
    k: number,
    q: number,
    queryGramSet: Map<number, number> | null,
  ): boolean {
    if (queryGramSet === null) return true; // 查询文本太短，无 q-gram 可用
    const maxLen = Math.max(queryPts.length, recordPts.length);
    if (Math.abs(queryPts.length - recordPts.length) > k) return false;
    const required = maxLen - q + 1 - k * q;
    if (required <= 0) return true;
    const recordGrams = recordPts.length - q + 1;
    if (recordGrams <= 0) return false; // 记录无 q-gram 而 required > 0，必不达标
    // sharedUpper = 记录中“哈希桶出现在查询集合里”的 gram 数（重数放宽），
    // 是真实共有数的上界；上界不足 required 才可排除。
    let sharedUpper = 0;
    for (let g = 0; g < recordGrams; g++) {
      if (queryGramSet.has(gramHash(recordPts, g, q))) sharedUpper++;
      if (sharedUpper >= required) return true;
    }
    return sharedUpper >= required;
  }
}
