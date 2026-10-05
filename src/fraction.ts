/** 精确有理数：n/d，d > 0，已约分 */
export interface Fraction {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

export function frac(n: bigint | number, d: bigint | number = 1): Fraction {
  let num = BigInt(n);
  let den = BigInt(d);
  if (den === 0n) throw new Error("fraction with zero denominator");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return { n: num / g, d: den / g };
}

export function add(a: Fraction, b: Fraction): Fraction {
  return frac(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function mul(a: Fraction, b: Fraction): Fraction {
  return frac(a.n * b.n, a.d * b.d);
}

export function div(a: Fraction, b: Fraction): Fraction {
  if (b.n === 0n) throw new Error("division by zero fraction");
  return frac(a.n * b.d, a.d * b.n);
}

export function cmp(a: Fraction, b: Fraction): number {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function floorBig(a: Fraction): bigint {
  const q = a.n / a.d;
  return a.n % a.d !== 0n && a.n < 0n ? q - 1n : q;
}

export function ceilBig(a: Fraction): bigint {
  return -floorBig({ n: -a.n, d: a.d });
}

/** 四舍五入，恰好半单位时向上取整：floor(x + 1/2) */
export function roundHalfUp(a: Fraction): bigint {
  return floorBig(add(a, frac(1, 2)));
}
