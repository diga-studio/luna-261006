/** 数量单位 */
export type Unit = 'g' | 'kg' | 'oz' | 'lb';

/** 十进制字符串表示的数量，例如 { value: "1.5", unit: "lb" } */
export interface Quantity {
  value: string;
  unit: Unit;
}

/** 菜谱汇总后传入的一条采购需求（同一原料可重复出现） */
export interface Requirement {
  ingredientId: string;
  quantity: Quantity;
}

/** 调用方自有库存中的一条 */
export interface OwnStock {
  ingredientId: string;
  quantity: Quantity;
}

/** 一个包装 SKU：只属于一种原料，不可拆分，有库存上限 */
export interface PackSku {
  skuId: string;
  ingredientId: string;
  size: Quantity;
  /** 正整数分 */
  priceCents: number;
  /** 可用包数（本次计算不扣减） */
  stock: number;
}

/** 购买方案中的一行 */
export interface PurchaseItem {
  skuId: string;
  packs: number;
}

/** 单个原料的配包结果；所有克数均为精确十进制字符串（单位 g） */
export interface IngredientPlan {
  ingredientId: string;
  /** 合并需求并扣除自有后的缺口（>= 0） */
  gapGrams: string;
  /** 实际购买到的总量 */
  coveredGrams: string;
  /** 未补足量（库存不足时 > 0） */
  shortfallGrams: string;
  /** 超额量（>= 0） */
  excessGrams: string;
  totalPriceCents: number;
  totalPacks: number;
  purchases: PurchaseItem[];
}

export interface PlanResult {
  plans: IngredientPlan[];
}
