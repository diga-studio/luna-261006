import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShoppingPlan, type ShoppingSnapshot } from "../src/index.js";

test("lower unit price for a bigger pack still loses on total price", () => {
  const snapshot: ShoppingSnapshot = {
    demands: [{ ingredientId: "rice", quantity: { value: "450", unit: "g" } }],
    owned: [],
    skus: [
      // 0.55 cents/g: cheaper per gram but costs more overall.
      { skuId: "rice-1kg", ingredientId: "rice", size: { value: "1", unit: "kg" }, priceCents: 550, stock: 5 },
      // 0.6 cents/g: pricier per gram, but 5 packs cover 450 g for 300c.
      { skuId: "rice-100g", ingredientId: "rice", size: { value: "100", unit: "g" }, priceCents: 60, stock: 10 },
    ],
  };
  const plan = buildShoppingPlan(snapshot);
  const rice = plan.ingredients[0]!;
  assert.equal(rice.required.value, "450");
  // Cheapest cover: 5 x 100 g = 500 g for 300c, with 50 g of excess.
  assert.deepEqual(
    rice.purchased.map((p) => [p.skuId, p.packs]),
    [["rice-100g", 5]],
  );
  assert.equal(rice.purchasedTotal.value, "500");
  assert.equal(rice.excess.value, "50");
  assert.equal(rice.shortage.value, "0");
  assert.equal(rice.totalPriceCents, 300);
});

test("cheapest pack is stock-limited and forces a mix", () => {
  const snapshot: ShoppingSnapshot = {
    demands: [{ ingredientId: "beans", quantity: { value: "1", unit: "kg" } }],
    owned: [],
    skus: [
      { skuId: "beans-500g", ingredientId: "beans", size: { value: "500", unit: "g" }, priceCents: 200, stock: 1 },
      { skuId: "beans-250g", ingredientId: "beans", size: { value: "250", unit: "g" }, priceCents: 150, stock: 10 },
    ],
  };
  const plan = buildShoppingPlan(snapshot);
  const beans = plan.ingredients[0]!;
  // 1 x 500 g + 2 x 250 g = 1000 g exactly for 500c (4 x 250 g would cost 600c).
  assert.deepEqual(
    beans.purchased.map((p) => [p.skuId, p.packs]),
    [
      ["beans-500g", 1],
      ["beans-250g", 2],
    ],
  );
  assert.equal(beans.purchasedTotal.value, "1000");
  assert.equal(beans.excess.value, "0");
  assert.equal(beans.shortage.value, "0");
  assert.equal(beans.totalPriceCents, 500);
});

test("total stock shortage: buy everything and report the exact gap", () => {
  const snapshot: ShoppingSnapshot = {
    demands: [{ ingredientId: "nuts", quantity: { value: "2", unit: "kg" } }],
    owned: [],
    skus: [
      { skuId: "nuts-500g", ingredientId: "nuts", size: { value: "500", unit: "g" }, priceCents: 200, stock: 2 },
      { skuId: "nuts-250g", ingredientId: "nuts", size: { value: "250", unit: "g" }, priceCents: 150, stock: 2 },
    ],
  };
  const plan = buildShoppingPlan(snapshot);
  const nuts = plan.ingredients[0]!;
  assert.equal(nuts.required.value, "2000");
  // Minimizing the shortage means buying all 1500 g of stock.
  assert.deepEqual(
    nuts.purchased.map((p) => [p.skuId, p.packs]),
    [
      ["nuts-500g", 2],
      ["nuts-250g", 2],
    ],
  );
  assert.equal(nuts.purchasedTotal.value, "1500");
  assert.equal(nuts.shortage.value, "500");
  assert.equal(nuts.excess.value, "0");
  assert.equal(nuts.totalPriceCents, 700);
});

test("mixed lb/oz/g packs combine into one optimal plan", () => {
  const snapshot: ShoppingSnapshot = {
    demands: [
      { ingredientId: "cocoa", quantity: { value: "0.5", unit: "kg" } },
      { ingredientId: "cocoa", quantity: { value: "500", unit: "g" } },
    ],
    owned: [],
    skus: [
      { skuId: "cocoa-1lb", ingredientId: "cocoa", size: { value: "1", unit: "lb" }, priceCents: 250, stock: 1 },
      { skuId: "cocoa-8oz", ingredientId: "cocoa", size: { value: "8", unit: "oz" }, priceCents: 130, stock: 5 },
      { skuId: "cocoa-100g", ingredientId: "cocoa", size: { value: "100", unit: "g" }, priceCents: 55, stock: 5 },
    ],
  };
  const plan = buildShoppingPlan(snapshot);
  const cocoa = plan.ingredients[0]!;
  assert.equal(cocoa.required.value, "1000");
  // 1 lb + 2 x 8 oz + 100 g = 1007.18474 g for 565c; every alternative costs more.
  assert.deepEqual(
    cocoa.purchased.map((p) => [p.skuId, p.packs]),
    [
      ["cocoa-1lb", 1],
      ["cocoa-8oz", 2],
      ["cocoa-100g", 1],
    ],
  );
  assert.equal(cocoa.purchasedTotal.value, "1007.18474");
  assert.equal(cocoa.excess.value, "7.18474");
  assert.equal(cocoa.shortage.value, "0");
  assert.equal(cocoa.totalPriceCents, 565);
});

test("equal price prefers less excess, then fewer packs", () => {
  const snapshot: ShoppingSnapshot = {
    demands: [{ ingredientId: "salt", quantity: { value: "500", unit: "g" } }],
    owned: [],
    skus: [
      { skuId: "salt-600g", ingredientId: "salt", size: { value: "600", unit: "g" }, priceCents: 300, stock: 2 },
      { skuId: "salt-500g", ingredientId: "salt", size: { value: "500", unit: "g" }, priceCents: 300, stock: 2 },
      { skuId: "salt-250g", ingredientId: "salt", size: { value: "250", unit: "g" }, priceCents: 150, stock: 4 },
    ],
  };
  const plan = buildShoppingPlan(snapshot);
  const salt = plan.ingredients[0]!;
  // 300c buys either 600 g (excess 100) or 500 g (excess 0): less excess wins.
  // 2 x 250 g also costs 300c with zero excess, but uses more packs.
  assert.deepEqual(
    salt.purchased.map((p) => [p.skuId, p.packs]),
    [["salt-500g", 1]],
  );
  assert.equal(salt.excess.value, "0");
  assert.equal(salt.totalPriceCents, 300);
});

test("zero gap after owned means no purchase at all", () => {
  const snapshot: ShoppingSnapshot = {
    demands: [{ ingredientId: "butter", quantity: { value: "1", unit: "lb" } }],
    owned: [{ ingredientId: "butter", quantity: { value: "16", unit: "oz" } }],
    skus: [
      { skuId: "butter-100g", ingredientId: "butter", size: { value: "100", unit: "g" }, priceCents: 80, stock: 9 },
    ],
  };
  const plan = buildShoppingPlan(snapshot);
  const butter = plan.ingredients[0]!;
  assert.equal(butter.required.value, "0");
  assert.equal(butter.purchased.length, 0);
  assert.equal(butter.totalPriceCents, 0);
  assert.equal(plan.totalPriceCents, 0);
});
