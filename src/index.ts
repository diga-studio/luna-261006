import type { OwnStock, PackSku, PlanResult, Requirement } from './types.js';

export * from './types.js';

/**
 * 购物清单配包优化主入口。所有输入均为调用方传入的内存快照，不持久化。
 */
export function planShopping(
  _requirements: Requirement[],
  _ownStocks: OwnStock[],
  _skus: PackSku[],
): PlanResult {
  throw new Error('not implemented');
}
