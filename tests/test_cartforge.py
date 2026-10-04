"""CartForge 自动化测试：规定场景、随机穷举对照、最大规模性能。"""
import random
import resource
import time
import unittest

from cartforge import InvalidPlanError, evaluate, quote


def brute_force_best(stores, codes):
    """独立穷举所有合法方案，返回最低总实付（仅用于小规模对照）。"""
    # 每店局部选项：(用到的券集合, 该店实付)
    per_store = []
    for st in stores:
        promos = [None] + list(st.get("promos", []))
        pcts = [c for c in codes if c["type"] == "percent" and st["id"] in c["shop_ids"]]
        fixes = [c for c in codes if c["type"] == "fixed" and st["id"] in c["shop_ids"]]
        combos = [(None, None)]
        combos += [(p, None) for p in pcts]
        combos += [(None, f) for f in fixes]
        combos += [(p, f) for p in pcts for f in fixes]
        opts = []
        for promo in promos:
            for pct, fix in combos:
                amount = st["subtotal"]
                used = set()
                if promo and amount >= promo["threshold"]:
                    amount = max(0, amount - promo["discount"])
                if pct and amount >= pct["threshold"]:
                    amount -= (amount * pct["percent"]) // 100
                    used.add(pct["id"])
                if fix and amount >= fix["threshold"]:
                    amount = max(0, amount - fix["value"])
                    used.add(fix["id"])
                ship = 0 if amount >= st["free_shipping_threshold"] else st["shipping"]
                opts.append((frozenset(used), amount + ship))
        per_store.append(opts)

    best = [float("inf")]

    def rec(i, used, total):
        if i == len(per_store):
            best[0] = min(best[0], total)
            return
        for u, cost in per_store[i]:
            if u & used:
                continue
            rec(i + 1, used | u, total + cost)

    rec(0, frozenset(), 0)
    return best[0]


class TestRequiredScenarios(unittest.TestCase):
    def test_two_stores_shared_percent_and_fixed(self):
        stores = [
            {"id": "A", "subtotal": 1000, "shipping": 0,
             "free_shipping_threshold": 0, "promos": []},
            {"id": "B", "subtotal": 1000, "shipping": 0,
             "free_shipping_threshold": 0, "promos": []},
        ]
        codes = [
            {"id": "P", "type": "percent", "percent": 50, "threshold": 0,
             "shop_ids": ["A", "B"]},
            {"id": "F", "type": "fixed", "value": 400, "threshold": 800,
             "shop_ids": ["A"]},
        ]
        result = quote(stores, codes)
        self.assertEqual(result["total"], 1100)
        # quote 的方案必须能被 evaluate 接受且金额一致
        check = evaluate(stores, codes, result["plan"])
        self.assertEqual(check["total"], 1100)
        # P 和 F 同时用于 A：P 后金额 500 < 800，F 门槛不满足，必须拒绝
        with self.assertRaises(InvalidPlanError):
            evaluate(stores, codes, {
                "A": {"promo": None, "percent_code": "P", "fixed_code": "F"},
                "B": {"promo": None, "percent_code": "P", "fixed_code": None},
            })

    def test_promo_not_max_discount_due_to_shipping(self):
        stores = [{"id": "S", "subtotal": 10000, "shipping": 2000,
                   "free_shipping_threshold": 9000,
                   "promos": [{"id": "m1", "threshold": 10000, "discount": 1000},
                              {"id": "m2", "threshold": 10000, "discount": 2000}]}]
        result = quote(stores, [])
        self.assertEqual(result["total"], 9000)
        self.assertEqual(result["plan"]["S"]["promo"], "m1")


class TestEvaluateRejects(unittest.TestCase):
    def setUp(self):
        self.stores = [
            {"id": "A", "subtotal": 1000, "shipping": 100,
             "free_shipping_threshold": 500,
             "promos": [{"id": "m", "threshold": 900, "discount": 100}]},
            {"id": "B", "subtotal": 1000, "shipping": 100,
             "free_shipping_threshold": 500, "promos": []},
        ]
        self.codes = [
            {"id": "P", "type": "percent", "percent": 10, "threshold": 0,
             "shop_ids": ["A", "B"]},
            {"id": "F", "type": "fixed", "value": 50, "threshold": 0,
             "shop_ids": ["B"]},
        ]

    def test_reject_duplicate_coupon_across_stores(self):
        with self.assertRaises(InvalidPlanError):
            evaluate(self.stores, self.codes, {
                "A": {"promo": None, "percent_code": "P", "fixed_code": None},
                "B": {"promo": None, "percent_code": "P", "fixed_code": None},
            })

    def test_reject_threshold_not_met(self):
        # 门槛 900，原价 800 不满足 -> 非法
        stores = [dict(self.stores[0], subtotal=800), self.stores[1]]
        with self.assertRaises(InvalidPlanError):
            evaluate(stores, self.codes, {
                "A": {"promo": "m", "percent_code": None, "fixed_code": None},
            })

    def test_reject_unknown_and_misplaced(self):
        with self.assertRaises(InvalidPlanError):
            evaluate(self.stores, self.codes, {"Z": {}})
        with self.assertRaises(InvalidPlanError):
            evaluate(self.stores, self.codes, {
                "A": {"promo": None, "percent_code": "F", "fixed_code": None},
            })
        with self.assertRaises(InvalidPlanError):
            evaluate(self.stores, self.codes, {
                "A": {"promo": None, "percent_code": None, "fixed_code": "F"},
            })  # F 不适用于 A

    def test_evaluate_recomputes_from_inputs(self):
        # plan 不带金额；evaluate 必须从输入重算
        result = evaluate(self.stores, self.codes, {
            "A": {"promo": "m", "percent_code": "P", "fixed_code": None},
            "B": {"promo": None, "percent_code": None, "fixed_code": "F"},
        })
        a = result["stores"]["A"]
        self.assertEqual((a["after_promo"], a["after_percent"]), (900, 810))
        self.assertEqual(a["shipping"], 0)
        b = result["stores"]["B"]
        self.assertEqual(b["after_fixed"], 950)
        self.assertEqual(result["total"], a["total"] + b["total"])


class TestRoundingAndThresholds(unittest.TestCase):
    def test_percent_floor_to_cent(self):
        stores = [{"id": "A", "subtotal": 999, "shipping": 0,
                   "free_shipping_threshold": 0, "promos": []}]
        codes = [{"id": "P", "type": "percent", "percent": 33, "threshold": 0,
                  "shop_ids": ["A"]}]
        r = evaluate(stores, codes,
                     {"A": {"promo": None, "percent_code": "P", "fixed_code": None}})
        self.assertEqual(r["stores"]["A"]["after_percent"], 999 - 329)  # 向下取整

    def test_threshold_exactly_equal(self):
        stores = [{"id": "A", "subtotal": 800, "shipping": 100,
                   "free_shipping_threshold": 800,
                   "promos": [{"id": "m", "threshold": 800, "discount": 0}]}]
        codes = [{"id": "F", "type": "fixed", "value": 1, "threshold": 800,
                  "shop_ids": ["A"]}]
        r = evaluate(stores, codes,
                     {"A": {"promo": None, "percent_code": None, "fixed_code": "F"}})
        self.assertEqual(r["stores"]["A"]["after_fixed"], 799)
        self.assertEqual(r["stores"]["A"]["shipping"], 100)  # 799 < 800 不免运


class TestExhaustiveCrossCheck(unittest.TestCase):
    def test_random_small_scale_against_brute_force(self):
        rng = random.Random(20261006)
        for trial in range(60):
            n_stores = rng.randint(1, 4)
            n_codes = rng.randint(0, 5)
            store_ids = [f"S{i}" for i in range(n_stores)]
            stores = []
            for sid in store_ids:
                promos = [
                    {"id": f"{sid}-m{k}",
                     "threshold": rng.choice([0, 100, 500, 1000]),
                     "discount": rng.choice([0, 50, 200, 1500])}
                    for k in range(rng.randint(0, 2))
                ]
                stores.append({
                    "id": sid,
                    "subtotal": rng.choice([0, 1, 333, 500, 999, 1000, 2000]),
                    "shipping": rng.choice([0, 100, 500]),
                    "free_shipping_threshold": rng.choice([0, 500, 1000]),
                    "promos": promos,
                })
            codes = []
            for k in range(n_codes):
                if rng.random() < 0.5:
                    codes.append({"id": f"C{k}", "type": "percent",
                                  "percent": rng.randint(1, 50),
                                  "threshold": rng.choice([0, 500, 1000]),
                                  "shop_ids": rng.sample(store_ids,
                                                         rng.randint(1, n_stores))})
                else:
                    codes.append({"id": f"C{k}", "type": "fixed",
                                  "value": rng.choice([1, 100, 700]),
                                  "threshold": rng.choice([0, 500, 1000]),
                                  "shop_ids": rng.sample(store_ids,
                                                         rng.randint(1, n_stores))})
            expected = brute_force_best(stores, codes)
            result = quote(stores, codes)
            self.assertEqual(result["total"], expected,
                             msg=f"trial {trial}: {stores} {codes}")
            # quote 方案必须合法且 evaluate 重算金额一致
            check = evaluate(stores, codes, result["plan"])
            self.assertEqual(check["total"], expected)


def _gen_max_scale(seed=7):
    rng = random.Random(seed)
    stores = []
    for i in range(24):
        sid = f"S{i}"
        promos = [
            {"id": f"{sid}-m{k}",
             "threshold": rng.randint(0, 8000),
             "discount": rng.randint(0, 3000)}
            for k in range(16)
        ]
        stores.append({
            "id": sid,
            "subtotal": rng.randint(1000, 20000),
            "shipping": rng.randint(0, 2000),
            "free_shipping_threshold": rng.randint(0, 15000),
            "promos": promos,
        })
    codes = []
    for k in range(12):
        # 竞争用券：多数券适用大量店铺；门槛设计使叠加资格随金额变化
        shop_ids = rng.sample([s["id"] for s in stores], rng.randint(8, 24))
        if k % 2 == 0:
            codes.append({"id": f"P{k}", "type": "percent",
                          "percent": rng.randint(1, 50),
                          "threshold": rng.randint(0, 10000),
                          "shop_ids": shop_ids})
        else:
            codes.append({"id": f"F{k}", "type": "fixed",
                          "value": rng.randint(100, 5000),
                          "threshold": rng.randint(0, 10000),
                          "shop_ids": shop_ids})
    return stores, codes


class TestMaxScalePerformance(unittest.TestCase):
    def test_max_scale_within_budget(self):
        stores, codes = _gen_max_scale()
        start = time.process_time()
        result = quote(stores, codes)
        cpu = time.process_time() - start
        peak_mib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024)
        print(f"\n[max-scale] cpu={cpu:.2f}s peak_rss={peak_mib:.1f}MiB "
              f"total={result['total']}")
        # 最优性佐证：quote 方案合法且 evaluate 重算一致
        check = evaluate(stores, codes, result["plan"])
        self.assertEqual(check["total"], result["total"])
        self.assertLess(cpu, 10.0)
        self.assertLess(peak_mib, 256.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
