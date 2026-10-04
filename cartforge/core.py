"""Single-store computation: apply one activity + coupons in fixed order.

Order per store is strictly: activity -> percent coupon -> fixed coupon.
Each step's threshold is checked against the goods amount right before that
step executes. Amounts never go below zero.
"""

from __future__ import annotations

from .models import Activity, Coupon, Store, StoreBreakdown


def compute_store(
    store: Store,
    activity: Activity | None,
    percent_coupon: Coupon | None,
    fixed_coupon: Coupon | None,
) -> StoreBreakdown | None:
    """Compute the per-stage amounts for one store.

    Returns ``None`` when any selected discount's threshold is not met at
    the moment it would apply (i.e. the combination is not usable).
    """
    amount = store.goods_amount
    original = amount

    if activity is not None:
        if amount < activity.min_amount:
            return None
        amount = max(0, amount - activity.reduction)
    after_activity = amount

    if percent_coupon is not None:
        if amount < percent_coupon.min_amount:
            return None
        amount -= amount * percent_coupon.percent // 100
    after_percent = amount

    if fixed_coupon is not None:
        if amount < fixed_coupon.min_amount:
            return None
        amount = max(0, amount - fixed_coupon.value)
    after_fixed = amount

    shipping = 0 if amount >= store.free_shipping_threshold else store.base_shipping
    return StoreBreakdown(
        store_id=store.id,
        original=original,
        after_activity=after_activity,
        after_percent=after_percent,
        after_fixed=after_fixed,
        shipping=shipping,
        total=amount + shipping,
    )
