/**
 * 精确有理数（BigInt 分子分母），用于素材覆盖范围的精确边界计算，
 * 避免浮点误差导致边界帧多迁移或漏迁移。分母恒为正，不要求约分。
 */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export function rationalFromInt(value: bigint): Rational {
  return { num: value, den: 1n };
}

export function rational(num: bigint, den: bigint): Rational {
  if (den === 0n) {
    throw new Error('rational: denominator must not be zero');
  }
  return den > 0n ? { num, den } : { num: -num, den: -den };
}

/** 比较 a 与 b，返回负数、0 或正数。 */
export function compare(a: Rational, b: Rational): number {
  const diff = a.num * b.den - b.num * a.den;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

/** 比较有理数与整数。 */
export function compareInt(a: Rational, value: bigint): number {
  const diff = a.num - value * a.den;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

export function maxValue(a: Rational, b: Rational): Rational {
  return compare(a, b) >= 0 ? a : b;
}

export function minValue(a: Rational, b: Rational): Rational {
  return compare(a, b) <= 0 ? a : b;
}

/**
 * 计算 floor((value - base) * mul / div)，要求 value >= base（base 为整数），
 * mul、div 为正整数。结果为非负 BigInt。用于把素材位置换算为切片序号。
 */
export function floorScaledDelta(
  value: Rational,
  base: bigint,
  mul: bigint,
  div: bigint,
): bigint {
  const num = (value.num - base * value.den) * mul;
  const den = value.den * div;
  if (num < 0n) {
    throw new Error('floorScaledDelta: value must be >= base');
  }
  return num / den;
}
