import { boundedDistanceCP, codePoints } from "./levenshtein.js";
import { GramIndex } from "./gramIndex.js";
import type { DuplicateCatalog, ListingRecord } from "./types.js";

const MIN_T_PERCENT = 70;
const MAX_T_PERCENT = 100;

/** 把 0.70~1.00、最多两位小数的阈值转换为百分制整数（70~100）。 */
function toPercent(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${name} 必须是有限数值，收到: ${String(value)}`);
  }
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-9) {
    throw new RangeError(`${name} 最多支持两位小数，收到: ${value}`);
  }
  if (rounded < MIN_T_PERCENT || rounded > MAX_T_PERCENT) {
    throw new RangeError(`${name} 必须在 0.70 至 1.00 之间，收到: ${value}`);
  }
  return rounded;
}

/** 校验阈值：范围 0.70 至 1.00，最多两位小数。非法时抛 RangeError。 */
export function assertValidThreshold(value: number, name: string): void {
  toPercent(value, name);
}

/** 该阈值与长度组合下允许的最大编辑距离：k = floor((100 - t) * M / 100)，整数精确计算。 */
function maxEdits(tPercent: number, maxLen: number): number {
  return Math.floor(((100 - tPercent) * maxLen) / 100);
}

class CatalogImpl implements DuplicateCatalog {
  private readonly records: readonly ListingRecord[];
  private readonly addrIndex = new GramIndex();
  private readonly descIndex = new GramIndex();

  constructor(records: readonly ListingRecord[]) {
    this.records = records.slice();
    for (const rec of this.records) {
      this.addrIndex.addRecord(rec.address);
      this.descIndex.addRecord(rec.description);
    }
    this.addrIndex.seal();
    this.descIndex.seal();
  }

  get size(): number {
    return this.records.length;
  }

  findDuplicates(
    query: ListingRecord,
    addressThreshold: number,
    descriptionThreshold: number,
  ): string[] {
    const addrTP = toPercent(addressThreshold, "addressThreshold");
    const descTP = toPercent(descriptionThreshold, "descriptionThreshold");
    const qAddr = codePoints(query.address);
    const qDesc = codePoints(query.description);

    // 选择倒排表扫描代价更小的字段作为驱动字段，另一字段只做逐对精确验证
    const addrCost = this.addrIndex.estimateCost(query.address);
    const descCost = this.descIndex.estimateCost(query.description);
    const driveAddress = addrCost <= descCost;

    const candidates = driveAddress
      ? this.addrIndex.query(query.address, addrTP)
      : this.descIndex.query(query.description, descTP);

    const hits: string[] = [];
    for (const id of candidates) {
      const rec = this.records[id]!;
      if (
        driveAddress
          ? this.matchField(qAddr, rec.address, addrTP) &&
            this.matchField(qDesc, rec.description, descTP)
          : this.matchField(qDesc, rec.description, descTP) &&
            this.matchField(qAddr, rec.address, addrTP)
      ) {
        hits.push(rec.id);
      }
    }
    return hits;
  }

  /** 单字段精确判定：相似度 >= tPercent/100（含恰好相等，整数判定不四舍五入）。 */
  private matchField(
    queryCps: readonly string[],
    recordText: string,
    tPercent: number,
  ): boolean {
    const recCps = codePoints(recordText);
    const m = Math.max(queryCps.length, recCps.length);
    const k = maxEdits(tPercent, m);
    return boundedDistanceCP(queryCps, recCps, k) <= k;
  }
}

/** 装入一份完整目录，返回可查询的目录对象。装入后目录不再修改。 */
export function loadCatalog(records: readonly ListingRecord[]): DuplicateCatalog {
  return new CatalogImpl(records);
}
