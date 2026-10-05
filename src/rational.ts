/**
 * 基于 BigInt 的精确有理数工具。
 * 变速映射会产生非整数倍速度，素材坐标用有理数精确表示，
 * 避免浮点误差导致边界帧多迁移或漏迁移。
 */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint; // 恒为正
}

export function rational(num: bigint | number, den: bigint | number = 1n): Rational {
  let n = BigInt(num);
  let d = BigInt(den);
  if (d === 0n) {
    throw new RangeError('rational denominator must not be zero');
  }
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  return { num: n, den: d };
}

/** a < b 时返回 -1，相等返回 0，a > b 返回 1。 */
export function compareRational(a: Rational, b: Rational): number {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}
