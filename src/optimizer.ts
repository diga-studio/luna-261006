import type { PackSku, PurchaseItem } from './types.js';

export interface OptimizeResult {
  purchases: PurchaseItem[];
  coveredUnits: bigint;
  totalPriceCents: number;
  totalPacks: number;
}

/**
 * 单原料配包优化。
 * 库存足以补齐 gapUnits 时：依次按 总价最低、超额量最少、包数最少 择优；
 * 库存不足时：先使未补足量最小，再按 总价、超额量、包数 择优。
 */
export function optimizePacks(_gapUnits: bigint, _skus: PackSku[]): OptimizeResult {
  throw new Error('not implemented');
}
