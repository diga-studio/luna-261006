import type { Quantity } from './types.js';

/** 把数量精确换算为内部整数刻度（1g = 1e9 刻度，1oz = 28.349523125g 精确） */
export function toUnits(_quantity: Quantity): bigint {
  throw new Error('not implemented');
}

/** 把内部整数刻度格式化为克（g）的十进制字符串 */
export function unitsToGramsString(_units: bigint): string {
  throw new Error('not implemented');
}
