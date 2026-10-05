/**
 * Exact rational arithmetic on bigints. All quantities are handled as exact
 * rationals so unit conversion, shortage checks and plan comparison never
 * lose precision.
 */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export const ZERO: Rational = { num: 0n, den: 1n };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

export function rational(num: bigint, den: bigint): Rational {
  if (den === 0n) {
    throw new Error("rational: denominator must not be zero");
  }
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { num: n / g, den: d / g };
}

export function fromBigInt(value: bigint): Rational {
  return { num: value, den: 1n };
}

/** Parse a non-negative decimal string like "12", "0.5", "28.349523125". */
export function parseDecimal(text: string): Rational {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new Error(`invalid decimal string: ${JSON.stringify(text)}`);
  }
  const intPart = match[1] as string;
  const fracPart = match[2] ?? "";
  const num = BigInt(intPart + fracPart);
  const den = 10n ** BigInt(fracPart.length);
  return rational(num, den);
}

export function add(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function sub(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mulInt(a: Rational, n: bigint): Rational {
  return rational(a.num * n, a.den);
}

/** Returns negative, zero or positive bigint as a < b, a == b, a > b. */
export function compare(a: Rational, b: Rational): number {
  const diff = a.num * b.den - b.num * a.den;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

export function isZero(a: Rational): boolean {
  return a.num === 0n;
}

export function max(a: Rational, b: Rational): Rational {
  return compare(a, b) >= 0 ? a : b;
}

/**
 * Format as a plain decimal string (no exponent). Denominators produced by
 * this library only have prime factors 2 and 5, so the expansion terminates.
 * Trailing zeros are trimmed; integers print without a decimal point.
 */
export function toDecimalString(a: Rational): string {
  if (a.num === 0n) {
    return "0";
  }
  if (a.num < 0n) {
    return "-" + toDecimalString({ num: -a.num, den: a.den });
  }
  // Strip factors 2 and 5 from the denominator; anything left would not
  // terminate, which this library never produces.
  let den = a.den;
  let twos = 0n;
  let fives = 0n;
  while (den % 2n === 0n) {
    den /= 2n;
    twos += 1n;
  }
  while (den % 5n === 0n) {
    den /= 5n;
    fives += 1n;
  }
  if (den !== 1n) {
    throw new Error("rational has no finite decimal expansion");
  }
  const scale = twos > fives ? twos : fives;
  let scaled = a.num;
  for (let i = twos; i < scale; i += 1n) scaled *= 2n;
  for (let i = fives; i < scale; i += 1n) scaled *= 5n;
  const digits = scaled.toString();
  const places = Number(scale);
  if (places === 0) {
    return digits;
  }
  const padded = digits.padStart(places + 1, "0");
  const intPart = padded.slice(0, padded.length - places);
  let fracPart = padded.slice(padded.length - places);
  fracPart = fracPart.replace(/0+$/, "");
  return fracPart === "" ? intPart : `${intPart}.${fracPart}`;
}
