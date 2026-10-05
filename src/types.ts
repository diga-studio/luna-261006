/** Supported mass units. */
export type Unit = "g" | "kg" | "oz" | "lb";

/**
 * A quantity expressed as a decimal string in a given unit.
 * The value must be a non-negative finite decimal, e.g. "1", "0.5", "28.349523125".
 */
export interface Quantity {
  value: string;
  unit: Unit;
}

/** One line of demand from the buyer (e.g. one ingredient of one recipe). */
export interface DemandItem {
  ingredientId: string;
  quantity: Quantity;
}

/** Amount of an ingredient the buyer already owns. */
export interface OwnedItem {
  ingredientId: string;
  quantity: Quantity;
}

/** A sellable, indivisible pack SKU. Each SKU belongs to exactly one ingredient. */
export interface PackSku {
  skuId: string;
  ingredientId: string;
  /** Net content of one pack. Must be strictly positive. */
  size: Quantity;
  /** Price per pack in cents. Must be a positive integer. */
  priceCents: number;
  /** Number of packs available. Must be a non-negative integer. */
  stock: number;
}

/** In-memory snapshot supplied by the caller. Nothing is persisted. */
export interface ShoppingSnapshot {
  demands: DemandItem[];
  owned: OwnedItem[];
  skus: PackSku[];
}

/** One purchased pack line of the resulting plan. */
export interface PurchasedPack {
  skuId: string;
  packs: number;
  /** Total net content of this line, normalized to grams. */
  totalSize: Quantity;
  totalPriceCents: number;
}

/** Purchase plan for a single ingredient. */
export interface IngredientPlan {
  ingredientId: string;
  /** Summed demand before subtracting owned, normalized to grams. */
  demanded: Quantity;
  /** Owned amount subtracted once, normalized to grams. */
  owned: Quantity;
  /** max(0, demanded - owned), normalized to grams. */
  required: Quantity;
  purchased: PurchasedPack[];
  /** Total net content purchased, normalized to grams. */
  purchasedTotal: Quantity;
  /** Unmet amount: max(0, required - purchasedTotal), normalized to grams. */
  shortage: Quantity;
  /** Over-purchased amount: max(0, purchasedTotal - required), normalized to grams. */
  excess: Quantity;
  totalPriceCents: number;
}

/** Full purchase plan across all ingredients. */
export interface ShoppingPlan {
  ingredients: IngredientPlan[];
  totalPriceCents: number;
}
