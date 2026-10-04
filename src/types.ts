/** 一条房源记录。文本已完成 Unicode NFC 规范化，本模块不再做任何文本改写。 */
export interface ListingRecord {
  /** 唯一记录标识 */
  readonly id: string;
  /** 已清洗的完整地址 */
  readonly address: string;
  /** 描述文本 */
  readonly description: string;
}

/** 重复候选检索目录：装入后不可变，查询无副作用。 */
export interface DuplicateCatalog {
  /** 目录记录数 */
  readonly size: number;
  /**
   * 为一条新房源查找目录中的全部重复候选。
   * 仅当地址与描述相似度均达到各自阈值（含恰好相等）时返回。
   * @returns 命中记录的标识数组，顺序按装入顺序
   */
  findDuplicates(
    query: ListingRecord,
    addressThreshold: number,
    descriptionThreshold: number,
  ): string[];
}
