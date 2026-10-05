#!/usr/bin/env python3
"""独立参考实现：为验收用例生成可复核的精确 p 值。

与 TypeScript 实现相互独立：
- 组合数对数用 mpmath 在 80 位精度下由 loggamma 直接计算（非递推前缀表）；
- 汇总使用 math.fsum（精确舍入求和）；
- 用两种不同的一半划分 {0,1}|{2,3} 与 {0,2}|{1,3} 交叉验证，
  两者差异即数值误差的上界估计。

数学依据：固定行边际 n_i 与总互动 M，计数表服从多重超几何分布
  P(table) = prod_i C(n_i, x_i) / C(N, M)，
p 值 = 所有 Pearson 卡方统计量 >= 观察统计量的表的概率之和。
"""
import math
import sys

import mpmath as mp

EXPOSURES = [12000, 18000, 27000, 43000]
ENGAGED = [220, 375, 510, 895]


def log_binomials(n, hi):
    """log C(n, x) for x in 0..hi，80 位精度计算后转 float64。"""
    with mp.workdps(80):
        lg = mp.loggamma(n + 1)
        return [float(lg - mp.loggamma(x + 1) - mp.loggamma(n - x + 1)) for x in range(hi + 1)]


def chi_square(ns, xs):
    n_total = sum(ns)
    m_total = sum(xs)
    p = m_total / n_total
    return sum((x - n * p) ** 2 / (n * p * (1 - p)) for n, x in zip(ns, xs))


def half_entries(idxs, ns, logc, m_total, other_cap):
    """枚举半个版本组，返回 {m: [(stat, logw), ...]}。"""
    buckets = {}
    caps = [min(ns[i], m_total) for i in idxs]
    p = m_total / sum(ns)

    def stat_of(i, x):
        n = ns[i]
        return (x - n * p) ** 2 / (n * p * (1 - p))

    if len(idxs) == 1:
        i = idxs[0]
        for x in range(max(0, m_total - other_cap), caps[0] + 1):
            buckets.setdefault(x, []).append((stat_of(i, x), logc[i][x]))
    else:
        i, j = idxs
        for xi in range(max(0, m_total - other_cap - caps[1]), caps[0] + 1):
            si = stat_of(i, xi)
            wi = logc[i][xi]
            for xj in range(max(0, m_total - other_cap - xi), min(caps[1], m_total - xi) + 1):
                buckets.setdefault(xi + xj, []).append((si + stat_of(j, xj), wi + logc[j][xj]))
    return buckets


def exact_p(ns, xs, split_a):
    n_total = sum(ns)
    m_total = sum(xs)
    k = len(ns)
    obs = chi_square(ns, xs)
    cutoff = obs - (obs * 1e-9 + 1e-12)

    logc = [log_binomials(n, min(n, m_total)) for n in ns]
    idx_a = list(split_a)
    idx_b = [i for i in range(k) if i not in split_a]
    cap_a = sum(min(ns[i], m_total) for i in idx_a)
    cap_b = sum(min(ns[i], m_total) for i in idx_b)

    buckets = half_entries(idx_a, ns, logc, m_total, cap_b)
    # 每桶按统计量排序，math.fsum 精确求后缀和（线性空间，桶内最大值缩放）。
    processed = {}
    for m, entries in buckets.items():
        entries.sort(key=lambda e: e[0])
        max_log = max(e[1] for e in entries)
        weights = [math.exp(e[1] - max_log) for e in entries]
        suffix = [0.0] * len(entries)
        acc = 0.0
        for t in range(len(entries) - 1, -1, -1):
            acc += weights[t]
            suffix[t] = acc
        processed[m] = ([e[0] for e in entries], suffix, max_log)

    # 第二半流式枚举，分子用“最大值缩放 + fsum”汇总。
    contribs = []  # (logw_contrib,)
    for m_b, entries_b in half_entries(idx_b, ns, logc, m_total, cap_a).items():
        target = processed.get(m_total - m_b)
        if target is None:
            continue
        stats, suffix, max_log = target
        for s_b, w_b in entries_b:
            threshold = cutoff - s_b
            lo, hi = 0, len(stats)
            while lo < hi:
                mid = (lo + hi) // 2
                if stats[mid] >= threshold:
                    hi = mid
                else:
                    lo = mid + 1
            if lo == len(stats):
                continue
            contribs.append(w_b + max_log + math.log(suffix[lo]))

    max_c = max(contribs)
    numerator = math.fsum(math.exp(c - max_c) for c in contribs)
    with mp.workdps(80):
        log_denom = float(mp.loggamma(n_total + 1) - mp.loggamma(m_total + 1) - mp.loggamma(n_total - m_total + 1))
    return numerator * math.exp(max_c - log_denom), obs


def main():
    p1, obs = exact_p(EXPOSURES, ENGAGED, {0, 1})
    p2, _ = exact_p(EXPOSURES, ENGAGED, {0, 2})
    print(f"chi2      = {obs:.17g}")
    print(f"p split01 = {p1:.17g}")
    print(f"p split02 = {p2:.17g}")
    print(f"|diff|    = {abs(p1 - p2):.3g}")
    if abs(p1 - p2) > 1e-11:
        print("WARNING: splits disagree", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
