/** DEM 网格元数据。坐标为米制平面坐标，节点非像元中心。 */
export interface DEMMeta {
  /** 节点列数（沿 x 方向） */
  width: number;
  /** 节点行数（沿 y 方向） */
  height: number;
  /** 左下角节点 x 坐标（米） */
  x0: number;
  /** 左下角节点 y 坐标（米） */
  y0: number;
  /** 网格间距（米），只允许 0.5 / 1 / 5 / 10 */
  step: number;
}

/** 挖填方比较结果。 */
export interface CompareResult {
  /** 共同有效面积（平方米） */
  area: number;
  /** 挖方量（立方码），旧高程减新高程的正部积分 */
  cut: number;
  /** 填方量（立方码），新高程减旧高程的正部积分 */
  fill: number;
}

export const ALLOWED_STEPS: readonly number[] = [0.5, 1, 5, 10];

/** 1 码 = 0.9144 米（严格定义） */
export const CUBIC_METERS_TO_CUBIC_YARDS = 1 / (0.9144 * 0.9144 * 0.9144);
