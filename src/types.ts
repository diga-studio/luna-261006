/** 单个文案版本的输入：曝光人数与其中至少互动一次的人数。 */
export interface VariantInput {
  /** 曝光人数，正整数。 */
  exposure: number;
  /** 至少互动一次的人数，整数，0 <= converted <= exposure。 */
  converted: number;
}

/** 一次整体比较的报告。 */
export interface ComparisonReport {
  /** Pearson 卡方统计量（互动/未互动两类）。 */
  chiSquare: number;
  /** 精确 p 值：统计量大于等于观察值的所有计数表的概率之和。 */
  pValue: number;
  /** 精确 p 值不大于 alpha 时为 true（恰好等于也算显著）。 */
  significant: boolean;
  /** 显著性水平，默认 0.05。 */
  alpha: number;
  /** 全部版本曝光人数之和。 */
  totalExposure: number;
  /** 全部版本互动人数之和。 */
  totalConverted: number;
}

/** 可选参数。 */
export interface CompareOptions {
  /** 显著性水平，默认 0.05。 */
  alpha?: number;
}
