import json, random, sys
sys.path.insert(0, "reference")  # 从仓库根目录运行
from compute_reference import brute_force

random.seed(20261005)
cases = []
while len(cases) < 15:
    m = random.choice([2, 3, 4])
    ns = [random.randint(1, 60) for _ in range(m)]
    xs = [random.randint(0, n) for n in ns]
    N, K = sum(ns), sum(xs)
    if K == 0 or K == N:
        continue
    cases.append((ns, xs))
# 额外加几个退化与极端比例用例
cases.append(([5, 7], [0, 0]))
cases.append(([5, 7], [5, 7]))
cases.append(([1, 59], [1, 0]))
cases.append(([2, 2, 2, 2], [2, 2, 0, 0]))

results = []
for ns, xs in cases:
    N = sum(ns); K = sum(xs)
    if K == 0 or K == N:
        results.append({"ns": ns, "xs": xs, "chi2": 0.0, "p": 1.0})
    else:
        chi2, p = brute_force(ns, xs)
        results.append({"ns": ns, "xs": xs, "chi2": float(chi2), "p": float(p)})
print(json.dumps(results))
