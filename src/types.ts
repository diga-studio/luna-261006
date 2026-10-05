/** 单个文案版本的输入：曝光人数与其中至少互动一次的人数。 */
export interface VariantInput {
  /** 曝光人数，正整数。 */
  exposure: number;
  /** 至少互动一次的人数，0 <= engaged <= exposure。 */
  engaged: number;
}

/** 一次整体比较的报告。 */
export interface ComparisonReport {
  /** Pearson 卡方统计量（互动/未互动两类）。 */
  chiSquare: number;
  /** 精确 p 值：统计量 >= 观察统计量的所有计数表的概率之和。 */
  pValue: number;
  /** 精确 p 值 <= 0.05 时判为整体显著。 */
  significant: boolean;
}
