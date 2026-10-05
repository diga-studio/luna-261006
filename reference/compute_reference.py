#!/usr/bin/env python3
"""验收参考值计算（仅标准库，精确整数/分数运算）。

数学依据：
- 固定各版本曝光 n_i 与总互动 K，计数表概率 = prod C(n_i, x_i) / C(N, K)。
- p 值 = 所有 Pearson 卡方统计量 >= 观察统计量的表的概率之和（等值计入）。
- 卡方统计量 = sum_i (x_i*N - n_i*K)^2 / (n_i*K*(N-K))，与
  S = sum_i (x_i*N - n_i*K)^2 / n_i 只差正常数因子，比较用 S 精确分数比较。

大case采用与库相同的两组分解枚举（A={0,1}, B={2,3}），
但全部权重用 math.comb 的精确整数，分子累加为精确大整数，
最后 p = 分子 / C(N, K) 为精确分数。浮点仅用于排序与窗口预选，
窗口内的表用 Fraction 精确判定，因此结果数学上精确。
"""
import bisect
import time
from fractions import Fraction
from itertools import product
from math import comb


def s_value(ns, xs, N, K):
    """精确 S = sum (x_i*N - n_i*K)^2 / n_i（Fraction）。"""
    return sum(Fraction((xs[i] * N - ns[i] * K) ** 2, ns[i]) for i in range(len(ns)))


def chi2_from_s(s, K, N):
    return s / (K * (N - K))


def brute_force(ns, xs_obs):
    """小规模：全枚举 + 精确分数，返回 (chi2, p) 精确分数。"""
    N = sum(ns)
    K = sum(xs_obs)
    s_obs = s_value(ns, xs_obs, N, K)
    caps = [min(n, K) for n in ns]
    num = 0
    den = comb(N, K)
    chi2_obs = chi2_from_s(s_obs, K, N)
    for xs in product(*(range(c + 1) for c in caps)):
        if sum(xs) != K:
            continue
        if s_value(ns, xs, N, K) >= s_obs:
            w = 1
            for i in range(len(ns)):
                w *= comb(ns[i], xs[i])
            num += w
    return chi2_obs, Fraction(num, den)


def big_case():
    ns = [12000, 18000, 27000, 43000]
    xs_obs = [220, 375, 510, 895]
    N = sum(ns)
    K = sum(xs_obs)
    assert K <= N - K
    s_obs = s_value(ns, xs_obs, N, K)
    chi2 = chi2_from_s(s_obs, K, N)
    print(f"chi2 = {float(chi2):.17g}")

    T = float(chi2)
    window = 1e-9 * max(1.0, T)
    caps = [min(n, K) for n in ns]
    cvals = [
        [float(chi2_from_s(Fraction((x * N - ns[i] * K) ** 2, ns[i]), K, N)) for x in range(caps[i] + 1)]
        for i in range(4)
    ]
    combs = [[comb(ns[i], x) for x in range(caps[i] + 1)] for i in range(4)]

    acc = 0  # 精确大整数分子
    t0 = time.time()
    # 按 kB（B 组互动数）分桶处理，控制内存：同一时刻只持有一个桶。
    for kB in range(K + 1):
        lo = max(0, kB - caps[3])
        hi = min(caps[2], kB)
        entries = []
        for x2 in range(lo, hi + 1):
            x3 = kB - x2
            entries.append((cvals[2][x2] + cvals[3][x3], combs[2][x2] * combs[3][x3], x2))
        entries.sort(key=lambda e: e[0])
        ss = [e[0] for e in entries]
        suff = [0] * (len(entries) + 1)
        for j in range(len(entries) - 1, -1, -1):
            suff[j] = suff[j + 1] + entries[j][1]
        kA = K - kB
        x0lo = max(0, kA - caps[1])
        x0hi = min(caps[0], kA)
        for x0 in range(x0lo, x0hi + 1):
            x1 = kA - x0
            theta = T - cvals[0][x0] - cvals[1][x1]
            jlo = bisect.bisect_left(ss, theta - window)
            jhi = bisect.bisect_right(ss, theta + window)
            w = combs[0][x0] * combs[1][x1]
            acc += w * suff[jhi]
            for j in range(jlo, jhi):
                x2 = entries[j][2]
                x3 = kB - x2
                if s_value(ns, (x0, x1, x2, x3), N, K) >= s_obs:
                    acc += w * (suff[j] - suff[j + 1])
        if kB % 400 == 0:
            print(f"  kB={kB}/{K} elapsed={time.time() - t0:.1f}s", flush=True)
    p = Fraction(acc, comb(N, K))
    print(f"p = {float(p):.17g}")
    from decimal import Decimal, getcontext

    getcontext().prec = 40
    print("p (30位十进制) =", Decimal(p.numerator) / Decimal(p.denominator))
    print(f"elapsed = {time.time() - t0:.1f}s")


if __name__ == "__main__":
    print("== 小case 1: n=[2,2,2,2], x=[2,2,0,0] ==")
    c, p = brute_force([2, 2, 2, 2], [2, 2, 0, 0])
    print(f"chi2 = {c} = {float(c)}, p = {p} = {float(p)}  (期望 p=3/35={float(Fraction(3,35))})")
    print("== 小case 2: n=[1,19], x=[1,0] ==")
    c, p = brute_force([1, 19], [1, 0])
    print(f"chi2 = {c} = {float(c)}, p = {p} = {float(p)}  (期望 p=1/20={float(Fraction(1,20))})")
    print("== 大case: n=[12000,18000,27000,43000], x=[220,375,510,895] ==")
    big_case()
