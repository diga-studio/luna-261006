import type {
  IngredientPlan,
  PackSku,
  PurchasedPack,
  ShoppingPlan,
  ShoppingSnapshot,
} from "./types.js";
import type { Rational } from "./rational.js";
import { ZERO, add, compare, max, mulInt, sub } from "./rational.js";
import { gramsQuantity, toGrams } from "./units.js";
import { optimizePacks, type PackOption } from "./optimize.js";

function validateSku(sku: PackSku): void {
  if (!Number.isInteger(sku.priceCents) || sku.priceCents <= 0) {
    throw new Error(
      `sku ${JSON.stringify(sku.skuId)}: priceCents must be a positive integer`,
    );
  }
  if (!Number.isInteger(sku.stock) || sku.stock < 0) {
    throw new Error(
      `sku ${JSON.stringify(sku.skuId)}: stock must be a non-negative integer`,
    );
  }
  if (compare(toGrams(sku.size), ZERO) <= 0) {
    throw new Error(`sku ${JSON.stringify(sku.skuId)}: size must be positive`);
  }
}

/**
 * Build the cheapest explainable purchase plan from an in-memory snapshot.
 *
 * Demands for the same ingredient are summed, the owned amount is subtracted
 * once (clamped at zero), and each ingredient is then packed independently.
 * Stock is only read, never mutated.
 */
export function buildShoppingPlan(snapshot: ShoppingSnapshot): ShoppingPlan {
  const demanded = new Map<string, Rational>();
  const owned = new Map<string, Rational>();
  const order: string[] = [];

  for (const item of snapshot.demands) {
    if (!demanded.has(item.ingredientId)) order.push(item.ingredientId);
    demanded.set(
      item.ingredientId,
      add(demanded.get(item.ingredientId) ?? ZERO, toGrams(item.quantity)),
    );
  }
  for (const item of snapshot.owned) {
    if (!demanded.has(item.ingredientId) && !owned.has(item.ingredientId)) {
      order.push(item.ingredientId);
    }
    owned.set(
      item.ingredientId,
      add(owned.get(item.ingredientId) ?? ZERO, toGrams(item.quantity)),
    );
  }

  const optionsByIngredient = new Map<string, PackOption[]>();
  const sizeBySku = new Map<string, Rational>();
  const priceBySku = new Map<string, number>();
  for (const sku of snapshot.skus) {
    validateSku(sku);
    const sizeGrams = toGrams(sku.size);
    sizeBySku.set(sku.skuId, sizeGrams);
    priceBySku.set(sku.skuId, sku.priceCents);
    const list = optionsByIngredient.get(sku.ingredientId) ?? [];
    list.push({
      skuId: sku.skuId,
      sizeGrams,
      priceCents: sku.priceCents,
      stock: sku.stock,
    });
    optionsByIngredient.set(sku.ingredientId, list);
  }

  const ingredients: IngredientPlan[] = [];
  let totalPriceCents = 0;

  for (const ingredientId of order) {
    const demandedGrams = demanded.get(ingredientId) ?? ZERO;
    const ownedGrams = owned.get(ingredientId) ?? ZERO;
    const requiredGrams = max(sub(demandedGrams, ownedGrams), ZERO);

    const options = optionsByIngredient.get(ingredientId) ?? [];
    const result =
      compare(requiredGrams, ZERO) > 0
        ? optimizePacks(requiredGrams, options)
        : undefined;

    const purchased: PurchasedPack[] = (result?.selections ?? []).map((sel) => {
      const sizeGrams = sizeBySku.get(sel.skuId) as Rational;
      const priceCents = priceBySku.get(sel.skuId) as number;
      return {
        skuId: sel.skuId,
        packs: sel.packs,
        totalSize: gramsQuantity(mulInt(sizeGrams, BigInt(sel.packs))),
        totalPriceCents: priceCents * sel.packs,
      };
    });

    const purchasedTotal = result?.totalGrams ?? ZERO;
    const shortage = result?.shortageGrams ?? ZERO;
    const excess = result?.excessGrams ?? ZERO;
    const price = result ? Number(result.totalPriceCents) : 0;
    totalPriceCents += price;

    ingredients.push({
      ingredientId,
      demanded: gramsQuantity(demandedGrams),
      owned: gramsQuantity(ownedGrams),
      required: gramsQuantity(requiredGrams),
      purchased,
      purchasedTotal: gramsQuantity(purchasedTotal),
      shortage: gramsQuantity(shortage),
      excess: gramsQuantity(excess),
      totalPriceCents: price,
    });
  }

  return { ingredients, totalPriceCents };
}
