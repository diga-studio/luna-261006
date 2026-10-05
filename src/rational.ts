/** 精确有理数：num/den，den > 0，已约分。 */
export interface Rat {
  num: bigint;
  den: bigint;
}

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

export function rat(num: bigint, den: bigint): Rat {
  if (den === 0n) throw new Error("rational with zero denominator");
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { num: n / g, den: d / g };
}

export function ratFromInt(value: bigint): Rat {
  return { num: value, den: 1n };
}

export function add(a: Rat, b: Rat): Rat {
  return rat(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function mul(a: Rat, b: Rat): Rat {
  return rat(a.num * b.num, a.den * b.den);
}

export function div(a: Rat, b: Rat): Rat {
  if (b.num === 0n) throw new Error("division by zero rational");
  return rat(a.num * b.den, a.den * b.num);
}

/** a < b */
export function lt(a: Rat, b: Rat): boolean {
  return a.num * b.den < b.num * a.den;
}

/** a > b */
export function gt(a: Rat, b: Rat): boolean {
  return a.num * b.den > b.num * a.den;
}

export function floorRat(a: Rat): bigint {
  const q = a.num / a.den;
  return a.num % a.den !== 0n && a.num < 0n ? q - 1n : q;
}

export function ceilRat(a: Rat): bigint {
  return -floorRat({ num: -a.num, den: a.den });
}

/** 四舍五入，恰好半单位时向上取整。 */
export function roundHalfUp(a: Rat): bigint {
  return floorRat(add(a, { num: 1n, den: 2n }));
}
