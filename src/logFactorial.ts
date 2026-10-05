/**
 * 构建 log(i!) 前缀表（i = 0..n），用于精确计算组合数对数：
 *   log C(a, b) = lf[a] - lf[b] - lf[a - b]
 *
 * 精度说明：p 值要求绝对误差 <= 1e-10，因此 log 权重的绝对误差必须远小于它。
 * 直接累加 Math.log(i) 到 1e5 项时，双精度舍入会累积到约 1e-8，不够用。
 * 这里使用 Neumaier 补偿求和，把累积误差压到 1e-13 量级；
 * 剩余的误差来源只有 Math.log 本身的舍入（随机游走约 1e-13）。
 */
export function buildLogFactorials(n: number): Float64Array {
  const lf = new Float64Array(n + 1);
  let sum = 0;
  let compensation = 0;
  for (let i = 1; i <= n; i += 1) {
    const term = Math.log(i);
    const t = sum + term;
    // Neumaier：对绝对值较大的那一方先减，保证补偿项不丢失。
    if (Math.abs(sum) >= Math.abs(term)) {
      compensation += (sum - t) + term;
    } else {
      compensation += (term - t) + sum;
    }
    sum = t;
    lf[i] = sum + compensation;
  }
  return lf;
}
