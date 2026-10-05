import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShoppingPlan, type ShoppingSnapshot } from "../src/index.js";

function baseSnapshot(): ShoppingSnapshot {
  return {
    demands: [{ ingredientId: "flour", quantity: { value: "100", unit: "g" } }],
    owned: [],
    skus: [
      { skuId: "s1", ingredientId: "flour", size: { value: "100", unit: "g" }, priceCents: 100, stock: 1 },
    ],
  };
}

test("rejects non-positive or non-integer prices", () => {
  const zero = baseSnapshot();
  zero.skus[0]!.priceCents = 0;
  assert.throws(() => buildShoppingPlan(zero), /priceCents/);
  const fractional = baseSnapshot();
  fractional.skus[0]!.priceCents = 9.99;
  assert.throws(() => buildShoppingPlan(fractional), /priceCents/);
});

test("rejects negative or fractional stock", () => {
  const negative = baseSnapshot();
  negative.skus[0]!.stock = -1;
  assert.throws(() => buildShoppingPlan(negative), /stock/);
  const fractional = baseSnapshot();
  fractional.skus[0]!.stock = 1.5;
  assert.throws(() => buildShoppingPlan(fractional), /stock/);
});

test("rejects malformed decimal strings and unknown units", () => {
  const badDecimal = baseSnapshot();
  badDecimal.demands[0]!.quantity.value = "1.2.3";
  assert.throws(() => buildShoppingPlan(badDecimal), /decimal/);
  const negative = baseSnapshot();
  negative.demands[0]!.quantity.value = "-5";
  assert.throws(() => buildShoppingPlan(negative), /decimal/);
  const badUnit = baseSnapshot();
  badUnit.demands[0]!.quantity = { value: "1", unit: "stone" as never };
  assert.throws(() => buildShoppingPlan(badUnit), /unit/);
});

test("rejects zero-size packs", () => {
  const snapshot = baseSnapshot();
  snapshot.skus[0]!.size = { value: "0", unit: "kg" };
  assert.throws(() => buildShoppingPlan(snapshot), /size/);
});
