import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShoppingPlan, type ShoppingSnapshot } from "../src/index.js";

test("duplicate demands merge, owned subtracted once, mixed lb/oz/g packs", () => {
  const snapshot: ShoppingSnapshot = {
    demands: [
      { ingredientId: "flour", quantity: { value: "1", unit: "lb" } },
      { ingredientId: "flour", quantity: { value: "8", unit: "oz" } },
      { ingredientId: "flour", quantity: { value: "0.5", unit: "lb" } },
    ],
    owned: [{ ingredientId: "flour", quantity: { value: "406.18474", unit: "g" } }],
    skus: [
      {
        skuId: "flour-1lb",
        ingredientId: "flour",
        size: { value: "1", unit: "lb" },
        priceCents: 250,
        stock: 5,
      },
      {
        skuId: "flour-8oz",
        ingredientId: "flour",
        size: { value: "8", unit: "oz" },
        priceCents: 130,
        stock: 5,
      },
      {
        skuId: "flour-100g",
        ingredientId: "flour",
        size: { value: "100", unit: "g" },
        priceCents: 55,
        stock: 5,
      },
    ],
  };
  const plan = buildShoppingPlan(snapshot);
  assert.equal(plan.ingredients.length, 1);
  const flour = plan.ingredients[0]!;
  // 1 lb + 8 oz + 0.5 lb = 453.59237 + 226.796185 + 226.796185 = 907.18474 g
  assert.equal(flour.demanded.value, "907.18474");
  assert.equal(flour.owned.value, "406.18474");
  assert.equal(flour.required.value, "501");
  // Cheapest cover of 501 g: 1x8 oz + 3x100 g = 526.796185 g for 295c,
  // beating 1x1 lb + 1x100 g (553.59237 g, 305c).
  assert.deepEqual(
    flour.purchased.map((p) => [p.skuId, p.packs]),
    [
      ["flour-8oz", 1],
      ["flour-100g", 3],
    ],
  );
  assert.equal(flour.purchasedTotal.value, "526.796185");
  assert.equal(flour.shortage.value, "0");
  // 526.796185 - 501 = 25.796185
  assert.equal(flour.excess.value, "25.796185");
  assert.equal(flour.totalPriceCents, 295);
  assert.equal(plan.totalPriceCents, 295);
});

test("exact equality across units counts as covered, zero excess", () => {
  const snapshot: ShoppingSnapshot = {
    demands: [{ ingredientId: "butter", quantity: { value: "1", unit: "lb" } }],
    owned: [],
    skus: [
      {
        skuId: "butter-16oz",
        ingredientId: "butter",
        size: { value: "16", unit: "oz" },
        priceCents: 199,
        stock: 3,
      },
    ],
  };
  const plan = buildShoppingPlan(snapshot);
  const butter = plan.ingredients[0]!;
  // 1 lb == 16 oz exactly: no shortage, no excess.
  assert.equal(butter.required.value, "453.59237");
  assert.equal(butter.shortage.value, "0");
  assert.equal(butter.excess.value, "0");
  assert.equal(butter.totalPriceCents, 199);
});

test("tiny residual shortage is not rounded away", () => {
  const snapshot: ShoppingSnapshot = {
    demands: [{ ingredientId: "sugar", quantity: { value: "1.000000001", unit: "lb" } }],
    owned: [],
    skus: [
      {
        skuId: "sugar-1lb",
        ingredientId: "sugar",
        size: { value: "1", unit: "lb" },
        priceCents: 150,
        stock: 1,
      },
    ],
  };
  const plan = buildShoppingPlan(snapshot);
  const sugar = plan.ingredients[0]!;
  assert.equal(sugar.required.value, "453.59237045359237");
  // 1e-9 lb = 0.00000045359237 g remains unmet and must be reported exactly.
  assert.equal(sugar.shortage.value, "0.00000045359237");
  assert.equal(sugar.excess.value, "0");
  assert.deepEqual(
    sugar.purchased.map((p) => [p.skuId, p.packs]),
    [["sugar-1lb", 1]],
  );
});

test("owned exceeding demand clamps required to zero and buys nothing", () => {
  const snapshot: ShoppingSnapshot = {
    demands: [{ ingredientId: "salt", quantity: { value: "10", unit: "g" } }],
    owned: [{ ingredientId: "salt", quantity: { value: "1", unit: "kg" } }],
    skus: [
      {
        skuId: "salt-100g",
        ingredientId: "salt",
        size: { value: "100", unit: "g" },
        priceCents: 50,
        stock: 10,
      },
    ],
  };
  const plan = buildShoppingPlan(snapshot);
  const salt = plan.ingredients[0]!;
  assert.equal(salt.required.value, "0");
  assert.equal(salt.purchased.length, 0);
  assert.equal(salt.shortage.value, "0");
  assert.equal(salt.excess.value, "0");
  assert.equal(plan.totalPriceCents, 0);
});

test("owned stock of one ingredient never covers another", () => {
  const snapshot: ShoppingSnapshot = {
    demands: [{ ingredientId: "rice", quantity: { value: "1", unit: "kg" } }],
    owned: [{ ingredientId: "wheat", quantity: { value: "5", unit: "kg" } }],
    skus: [
      {
        skuId: "rice-1kg",
        ingredientId: "rice",
        size: { value: "1", unit: "kg" },
        priceCents: 400,
        stock: 2,
      },
    ],
  };
  const plan = buildShoppingPlan(snapshot);
  const rice = plan.ingredients.find((i) => i.ingredientId === "rice")!;
  assert.equal(rice.required.value, "1000");
  assert.equal(rice.totalPriceCents, 400);
  const wheat = plan.ingredients.find((i) => i.ingredientId === "wheat")!;
  assert.equal(wheat.required.value, "0");
  assert.equal(wheat.purchased.length, 0);
});
