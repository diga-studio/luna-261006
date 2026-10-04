"""Optimal plan search for ``quote``.

Dynamic programming over the set of shared coupons: per store we enumerate
every usable local combination (activity x percent coupon x fixed coupon),
keep the cheapest option per coupon-usage mask, drop dominated options, and
combine stores with an exact subset DP over coupon masks. No candidate
truncation, no local-greedy pre-commitment, no floating point.
"""

from __future__ import annotations

from .core import compute_store
from .models import Coupon, Plan, QuoteResult, Store, StoreChoice


def _store_options(
    store: Store,
    percent: list[tuple[int, Coupon]],
    fixed: list[tuple[int, Coupon]],
) -> list[tuple[int, int, object, object, object]]:
    """Build (mask, total, activity, pct_coupon, fix_coupon) options.

    Only the cheapest choice per coupon-usage mask survives, then options
    dominated by another option using a subset of the coupons at no higher
    cost are dropped (they can never belong to an optimal plan).
    """
    best: dict[int, tuple[int, object, object, object]] = {}
    pct_choices: list[tuple[int, object]] = [(0, None)] + percent
    fix_choices: list[tuple[int, object]] = [(0, None)] + fixed
    activities: list[object] = [None, *store.activities]
    for pmask, pct in pct_choices:
        for fmask, fix in fix_choices:
            mask = pmask | fmask
            for act in activities:
                bd = compute_store(store, act, pct, fix)
                if bd is None:
                    continue
                cur = best.get(mask)
                if cur is None or bd.total < cur[0]:
                    best[mask] = (bd.total, act, pct, fix)
    options = [
        (mask, total, act, pct, fix)
        for mask, (total, act, pct, fix) in best.items()
    ]
    keep: list[tuple[int, int, object, object, object]] = []
    for mask, total, act, pct, fix in options:
        dominated = False
        for omask, ototal, *_ in options:
            if omask != mask and omask & mask == omask and ototal <= total:
                dominated = True
                break
        if not dominated:
            keep.append((mask, total, act, pct, fix))
    return keep


def quote(stores: list[Store], codes: list[Coupon]) -> QuoteResult:
    """Return an optimal plan and its breakdown for the whole checkout."""
    percent: list[tuple[int, Coupon]] = []
    fixed: list[tuple[int, Coupon]] = []
    for bit, coupon in enumerate(codes):
        entry = (1 << bit, coupon)
        (percent if coupon.is_percent else fixed).append(entry)

    per_store: list[list[tuple[int, int, object, object, object]]] = []
    for store in stores:
        pcts = [(m, c) for m, c in percent if store.id in c.store_ids]
        fixs = [(m, c) for m, c in fixed if store.id in c.store_ids]
        per_store.append(_store_options(store, pcts, fixs))

    size = 1 << len(codes)
    inf = float("inf")
    dp = [inf] * size
    dp[0] = 0
    parents: list[list[int]] = []
    for options in per_store:
        ndp = [inf] * size
        parent = [-1] * size
        nopts = len(options)
        for mask in range(size):
            base = dp[mask]
            if base == inf:
                continue
            for idx in range(nopts):
                omask, cost = options[idx][0], options[idx][1]
                if mask & omask:
                    continue
                nmask = mask | omask
                cand = base + cost
                if cand < ndp[nmask]:
                    ndp[nmask] = cand
                    parent[nmask] = mask * nopts + idx
        dp = ndp
        parents.append(parent)

    final_mask = min(range(size), key=lambda m: (dp[m], m))
    total = dp[final_mask]

    chosen: list[tuple[object, object, object]] = []
    mask = final_mask
    for i in range(len(per_store) - 1, -1, -1):
        packed = parents[i][mask]
        nopts = len(per_store[i])
        prev_mask, idx = divmod(packed, nopts)
        _, _, act, pct, fix = per_store[i][idx]
        chosen.append((act, pct, fix))
        mask = prev_mask
    chosen.reverse()

    choices = []
    breakdowns = []
    for store, (act, pct, fix) in zip(stores, chosen):
        choices.append(
            StoreChoice(
                store_id=store.id,
                activity_id=act.id if act else None,
                percent_coupon_id=pct.id if pct else None,
                fixed_coupon_id=fix.id if fix else None,
            )
        )
        breakdowns.append(compute_store(store, act, pct, fix))
    return QuoteResult(plan=Plan(tuple(choices)), breakdowns=tuple(breakdowns), total=total)
