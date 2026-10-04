"""Evaluation of a caller-supplied plan without any optimization.

Recomputes every amount from the inputs; never trusts amounts carried by
the plan. Any illegality (unknown ids, duplicate coupon use, unmet
thresholds, more than one discount of a kind per store, ...) raises
``InvalidPlanError`` instead of being auto-corrected.
"""

from __future__ import annotations

from .core import compute_store
from .models import Coupon, InvalidPlanError, Plan, QuoteResult, Store


def evaluate(stores: list[Store], codes: list[Coupon], plan: Plan) -> QuoteResult:
    """Check ``plan`` for legality and recompute its breakdown."""
    store_by_id = {s.id: s for s in stores}
    if len(store_by_id) != len(stores):
        raise InvalidPlanError("duplicate store id in stores")
    coupon_by_id = {c.id: c for c in codes}
    if len(coupon_by_id) != len(codes):
        raise InvalidPlanError("duplicate coupon id in codes")

    seen_store_ids: set[str] = set()
    choices = list(plan.choices)
    if len(choices) != len(stores):
        raise InvalidPlanError("plan must contain exactly one choice per store")

    used_coupons: set[str] = set()
    breakdowns = []
    for choice in choices:
        store = store_by_id.get(choice.store_id)
        if store is None:
            raise InvalidPlanError(f"unknown store id: {choice.store_id!r}")
        if choice.store_id in seen_store_ids:
            raise InvalidPlanError(f"duplicate choice for store: {choice.store_id!r}")
        seen_store_ids.add(choice.store_id)

        activity = None
        if choice.activity_id is not None:
            for act in store.activities:
                if act.id == choice.activity_id:
                    activity = act
                    break
            if activity is None:
                raise InvalidPlanError(
                    f"activity {choice.activity_id!r} does not belong to "
                    f"store {store.id!r}"
                )

        pct_coupon = None
        fix_coupon = None
        for cid, kind in (
            (choice.percent_coupon_id, "percent"),
            (choice.fixed_coupon_id, "fixed"),
        ):
            if cid is None:
                continue
            coupon = coupon_by_id.get(cid)
            if coupon is None:
                raise InvalidPlanError(f"unknown coupon id: {cid!r}")
            if store.id not in coupon.store_ids:
                raise InvalidPlanError(
                    f"coupon {cid!r} is not usable at store {store.id!r}"
                )
            if cid in used_coupons:
                raise InvalidPlanError(f"coupon {cid!r} used more than once")
            used_coupons.add(cid)
            if kind == "percent":
                if not coupon.is_percent:
                    raise InvalidPlanError(f"coupon {cid!r} is not a percent coupon")
                pct_coupon = coupon
            else:
                if coupon.is_percent:
                    raise InvalidPlanError(f"coupon {cid!r} is not a fixed coupon")
                fix_coupon = coupon

        breakdown = compute_store(store, activity, pct_coupon, fix_coupon)
        if breakdown is None:
            raise InvalidPlanError(
                f"discount thresholds not met for store {store.id!r}"
            )
        breakdowns.append(breakdown)

    return QuoteResult(
        plan=plan,
        breakdowns=tuple(breakdowns),
        total=sum(b.total for b in breakdowns),
    )
