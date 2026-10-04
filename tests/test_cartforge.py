"""Automated tests for cartforge: required cases, brute-force cross-check,
and a max-scale performance test."""

from __future__ import annotations

import itertools
import random
import resource
import sys
import time
import unittest

from cartforge import (
    Activity,
    Coupon,
    InvalidPlanError,
    Plan,
    Store,
    StoreChoice,
    evaluate,
    quote,
)
from cartforge.core import compute_store


def brute_force_total(stores, codes):
    """Independent exact enumerator: every legal plan, no reuse of library DP."""
    pct = [(1 << i, c) for i, c in enumerate(codes) if c.is_percent]
    fix = [(1 << i, c) for i, c in enumerate(codes) if not c.is_percent]
    per_store = []
    for s in stores:
        opts = []
        ps = [(0, None)] + [(m, c) for m, c in pct if s.id in c.store_ids]
        fs = [(0, None)] + [(m, c) for m, c in fix if s.id in c.store_ids]
        for (pm, p), (fm, f) in itertools.product(ps, fs):
            for act in itertools.chain([None], s.activities):
                bd = compute_store(s, act, p, f)
                if bd is not None:
                    opts.append((pm | fm, bd.total))
        per_store.append(opts)

    best = [float("inf")]

    def dfs(i, mask, acc):
        if acc >= best[0]:
            return
        if i == len(per_store):
            best[0] = acc
            return
        for omask, cost in per_store[i]:
            if not mask & omask:
                dfs(i + 1, mask | omask, acc + cost)

    dfs(0, 0, 0)
    return best[0]


class RequiredCasesTest(unittest.TestCase):
    def test_two_stores_shared_percent_and_store_fixed(self):
        stores = [
            Store(id="A", goods_amount=1000, base_shipping=0,
                  free_shipping_threshold=0),
            Store(id="B", goods_amount=1000, base_shipping=0,
                  free_shipping_threshold=0),
        ]
        codes = [
            Coupon(id="P", store_ids=frozenset({"A", "B"}), min_amount=0,
                   percent=50),
            Coupon(id="F", store_ids=frozenset({"A"}), min_amount=800,
                   value=400),
        ]
        result = quote(stores, codes)
        self.assertEqual(result.total, 1100)
        # Optimal plan must be legal under evaluate and match.
        self.assertEqual(evaluate(stores, codes, result.plan).total, 1100)
        # P and F both on A is illegal (500 < 800 after percent step).
        bad = Plan((
            StoreChoice("A", percent_coupon_id="P", fixed_coupon_id="F"),
            StoreChoice("B"),
        ))
        with self.assertRaises(InvalidPlanError):
            evaluate(stores, codes, bad)

    def test_biggest_reduction_is_not_always_best(self):
        stores = [
            Store(
                id="S",
                goods_amount=10000,
                base_shipping=2000,
                free_shipping_threshold=9000,
                activities=(
                    Activity(id="A1", min_amount=10000, reduction=1000),
                    Activity(id="A2", min_amount=10000, reduction=2000),
                ),
            )
        ]
        result = quote(stores, [])
        self.assertEqual(result.total, 9000)
        choice = result.plan.choices[0]
        self.assertEqual(choice.activity_id, "A1")
        bd = result.breakdowns[0]
        self.assertEqual((bd.after_activity, bd.shipping), (9000, 0))


class BruteForceCrossCheckTest(unittest.TestCase):
    def test_random_small_cases_match_brute_force(self):
        rng = random.Random(20261006)
        for case in range(300):
            n_stores = rng.randint(1, 4)
            n_coupons = rng.randint(0, 5)
            store_ids = [f"S{i}" for i in range(n_stores)]
            stores = []
            for sid in store_ids:
                acts = tuple(
                    Activity(
                        id=f"{sid}-a{j}",
                        min_amount=rng.choice([0, 500, 1000, 2000, 3000]),
                        reduction=rng.choice([100, 333, 500, 999, 1500]),
                    )
                    for j in range(rng.randint(0, 3))
                )
                stores.append(Store(
                    id=sid,
                    goods_amount=rng.choice([0, 1, 999, 1000, 2500, 5000]),
                    base_shipping=rng.choice([0, 300, 800]),
                    free_shipping_threshold=rng.choice([0, 1000, 2000, 4000]),
                    activities=acts,
                ))
            codes = []
            for j in range(n_coupons):
                eligible = frozenset(
                    sid for sid in store_ids if rng.random() < 0.7
                ) or frozenset({store_ids[0]})
                if rng.random() < 0.5:
                    codes.append(Coupon(
                        id=f"C{j}", store_ids=eligible,
                        min_amount=rng.choice([0, 500, 1000, 2000]),
                        percent=rng.randint(1, 50),
                    ))
                else:
                    codes.append(Coupon(
                        id=f"C{j}", store_ids=eligible,
                        min_amount=rng.choice([0, 500, 1000, 2000]),
                        value=rng.choice([100, 250, 700, 1200]),
                    ))
            expected = brute_force_total(stores, codes)
            result = quote(stores, codes)
            self.assertEqual(result.total, expected, f"case {case}")
            # The quoted plan must be legal and reproduce the same total.
            checked = evaluate(stores, codes, result.plan)
            self.assertEqual(checked.total, expected, f"case {case}")


class MaxScaleTest(unittest.TestCase):
    def test_max_scale_within_budget(self):
        rng = random.Random(7)
        n_stores, n_acts, n_coupons = 24, 16, 12
        store_ids = [f"S{i}" for i in range(n_stores)]
        stores = []
        for sid in store_ids:
            acts = tuple(
                Activity(
                    id=f"{sid}-a{j}",
                    min_amount=rng.choice([0, 2000, 5000, 8000, 12000]),
                    reduction=rng.choice([300, 800, 1500, 2500, 4000]),
                )
                for j in range(n_acts)
            )
            stores.append(Store(
                id=sid,
                goods_amount=rng.randint(1000, 20000),
                base_shipping=rng.choice([0, 500, 1000]),
                free_shipping_threshold=rng.choice([0, 6000, 10000, 15000]),
                activities=acts,
            ))
        codes = []
        for j in range(n_coupons):
            # Competing coupons: each usable at many stores, forcing real
            # cross-store allocation decisions.
            eligible = frozenset(
                sid for sid in store_ids if rng.random() < 0.6
            ) or frozenset({store_ids[0]})
            if j % 2 == 0:
                codes.append(Coupon(
                    id=f"C{j}", store_ids=eligible,
                    min_amount=rng.choice([0, 3000, 6000]),
                    percent=rng.randint(5, 50),
                ))
            else:
                codes.append(Coupon(
                    id=f"C{j}", store_ids=eligible,
                    min_amount=rng.choice([0, 3000, 6000]),
                    value=rng.choice([500, 1500, 3000]),
                ))

        start = time.process_time()
        result = quote(stores, codes)
        cpu = time.process_time() - start
        raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # macOS reports bytes, Linux reports KiB.
        peak_mib = raw / (1024 * 1024) if sys.platform == "darwin" else raw / 1024
        print(f"\nmax-scale: cpu={cpu:.2f}s peak={peak_mib:.1f}MiB "
              f"total={result.total}")
        self.assertLess(cpu, 10.0)
        self.assertLess(peak_mib, 256.0)
        # Quoted plan must be legal and consistent.
        self.assertEqual(evaluate(stores, codes, result.plan).total,
                         result.total)


if __name__ == "__main__":
    unittest.main()
