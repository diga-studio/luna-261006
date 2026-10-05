import type { Quantity, Unit } from "./types.js";
import type { Rational } from "./rational.js";
import { parseDecimal, rational, toDecimalString } from "./rational.js";

const GRAMS_PER_G = rational(1n, 1n);
const GRAMS_PER_KG = rational(1000n, 1n);
// 1 oz = 28.349523125 g exactly.
const GRAMS_PER_OZ = rational(28349523125n, 1000000000n);
// 1 lb = 16 oz = 453.59237 g exactly.
const GRAMS_PER_LB = rational(453592370000n, 1000000000n);

/** Exact grams-per-unit factor (1 oz = 28.349523125 g exactly). */
export function gramsPerUnit(unit: Unit): Rational {
  switch (unit) {
    case "g":
      return GRAMS_PER_G;
    case "kg":
      return GRAMS_PER_KG;
    case "oz":
      return GRAMS_PER_OZ;
    case "lb":
      return GRAMS_PER_LB;
    default:
      throw new Error(`unsupported unit: ${JSON.stringify(unit)}`);
  }
}

/** Parse a quantity and convert to exact grams. Throws on invalid input. */
export function toGrams(quantity: Quantity): Rational {
  const value = parseDecimal(quantity.value);
  const factor = gramsPerUnit(quantity.unit);
  return rational(value.num * factor.num, value.den * factor.den);
}

/** Format exact grams as a Quantity in grams with a decimal string value. */
export function gramsQuantity(grams: Rational): Quantity {
  return { value: toDecimalString(grams), unit: "g" };
}
