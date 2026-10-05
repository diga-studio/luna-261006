/**
 * Exact decimal money handling. Amounts have at most 4 fractional digits
 * and are stored scaled by 10^4 as integer "units". Per-currency cumulative
 * absolute movement is bounded by 10^13 (10 trillion), i.e. 10^17 units,
 * which exceeds 2^53, so hot-path arithmetic splits each value into a
 * high part (multiple of 10^7 units) and a low part, both exact in float64.
 */

export const SCALE = 10000;
export const SPLIT = 10000000; // 10^7 units per high part

const AMOUNT_RE = /^(-?)(\d+)(?:\.(\d{1,4}))?$/;

/** Parse an amount into scaled integer units. Throws on invalid input. */
export function parseAmount(value: number | string): bigint {
  const text = typeof value === "number" ? String(value) : value;
  const m = AMOUNT_RE.exec(text);
  if (m === null) {
    throw new Error(
      `invalid amount "${text}": expected a decimal with at most 4 fractional digits`
    );
  }
  const frac = (m[3] ?? "").padEnd(4, "0");
  const units = BigInt(m[2]) * 10000n + BigInt(frac === "" ? "0" : frac);
  return m[1] === "-" ? -units : units;
}

/** Split scaled units into [hi, lo] with units = hi * SPLIT + lo. */
export function splitUnits(units: bigint): [number, number] {
  const hi = units / BigInt(SPLIT);
  const lo = units - hi * BigInt(SPLIT);
  return [Number(hi), Number(lo)];
}

/** Recombine accumulated hi/lo parts into exact scaled units. */
export function combineUnits(hi: number, lo: number): bigint {
  return BigInt(Math.round(hi)) * BigInt(SPLIT) + BigInt(Math.round(lo));
}

/** Format scaled units as a canonical decimal string (trailing zeros trimmed). */
export function formatUnits(units: bigint): string {
  if (units === 0n) {
    return "0";
  }
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const intPart = abs / 10000n;
  let fracPart = (abs % 10000n).toString().padStart(4, "0");
  fracPart = fracPart.replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracPart === "" ? `${sign}${intPart}` : `${sign}${intPart}.${fracPart}`;
}
