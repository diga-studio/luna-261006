import type { RationalValue } from "./types.js";

/** 基于 BigInt 的精确有理数，自动约分，分母恒为正。 */
export class Rational implements RationalValue {
  readonly numerator: bigint;
  readonly denominator: bigint;

  private constructor(numerator: bigint, denominator: bigint) {
    this.numerator = numerator;
    this.denominator = denominator;
  }

  static of(numerator: bigint, denominator: bigint = 1n): Rational {
    if (denominator === 0n) {
      throw new Error("Rational: denominator must not be zero");
    }
    if (denominator < 0n) {
      numerator = -numerator;
      denominator = -denominator;
    }
    const common = gcd(abs(numerator), denominator);
    return new Rational(numerator / common, denominator / common);
  }

  static zero(): Rational {
    return new Rational(0n, 1n);
  }

  add(other: Rational): Rational {
    return Rational.of(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  mul(other: Rational): Rational {
    return Rational.of(
      this.numerator * other.numerator,
      this.denominator * other.denominator,
    );
  }

  div(other: Rational): Rational {
    if (other.numerator === 0n) {
      throw new Error("Rational: division by zero");
    }
    return Rational.of(
      this.numerator * other.denominator,
      this.denominator * other.numerator,
    );
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  /** 四舍五入到整数，正好一半时向上（远离零方向，金额非负）。 */
  roundHalfUp(): bigint {
    const quotient = this.numerator / this.denominator;
    const remainder = this.numerator % this.denominator;
    if (remainder * 2n >= this.denominator) {
      return quotient + 1n;
    }
    return quotient;
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}
