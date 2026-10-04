/** DEM 网格元数据。坐标系为米制平面坐标，网格轴向一致。 */
export interface DEMMeta {
  /** 节点列数（沿 x 方向） */
  width: number;
  /** 节点行数（沿 y 方向） */
  height: number;
  /** 左下角节点 x 坐标（米） */
  x0: number;
  /** 左下角节点 y 坐标（米） */
  y0: number;
  /** 网格间距（米），仅允许 0.5、1、5、10 */
  step: number;
}

/** compareDEMs 的返回结果。 */
export interface CompareResult {
  /** 共同有效面积（平方米） */
  commonArea: number;
  /** 挖方量（立方码）：旧高程减新高程的正部在比较域上的积分 */
  cutVolume: number;
  /** 填方量（立方码）：新高程减旧高程的正部在比较域上的积分 */
  fillVolume: number;
}
