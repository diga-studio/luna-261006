"""CartForge 核心数据类型与单店核算（仅标准库）。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple


class InvalidPlanError(ValueError):
    """evaluate 检测到非法方案时抛出。"""


@dataclass(frozen=True)
class Promo:
    id: str
    threshold: int
    discount: int


@dataclass(frozen=True)
class Store:
    id: str
    subtotal: int
    shipping: int
    free_shipping_threshold: int
    promos: Tuple[Promo, ...] = ()


@dataclass(frozen=True)
class Coupon:
    id: str
    shop_ids: frozenset
    threshold: int
    kind: str  # "percent" 或 "fixed"
    percent: Optional[int] = None
    value: Optional[int] = None


def _require_int(value, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} 必须为整数分: {value!r}")
    if value < 0:
        raise ValueError(f"{name} 不能为负: {value!r}")
    return value


def parse_stores(stores: Sequence[dict]) -> List[Store]:
    result: List[Store] = []
    seen = set()
    for raw in stores:
        sid = raw["id"]
        if sid in seen:
            raise ValueError(f"店铺 id 重复: {sid!r}")
        seen.add(sid)
        promos = tuple(
            Promo(
                id=p["id"],
                threshold=_require_int(p["threshold"], "promo.threshold"),
                discount=_require_int(p["discount"], "promo.discount"),
            )
            for p in raw.get("promos", ())
        )
        promo_ids = [p.id for p in promos]
        if len(set(promo_ids)) != len(promo_ids):
            raise ValueError(f"店铺 {sid!r} 的满减活动 id 重复")
        result.append(
            Store(
                id=sid,
                subtotal=_require_int(raw["subtotal"], "subtotal"),
                shipping=_require_int(raw["shipping"], "shipping"),
                free_shipping_threshold=_require_int(
                    raw["free_shipping_threshold"], "free_shipping_threshold"
                ),
                promos=promos,
            )
        )
    return result


def parse_coupons(codes: Sequence[dict]) -> List[Coupon]:
    result: List[Coupon] = []
    seen = set()
    for raw in codes:
        cid = raw["id"]
        if cid in seen:
            raise ValueError(f"优惠券 id 重复: {cid!r}")
        seen.add(cid)
        kind = raw["type"]
        threshold = _require_int(raw["threshold"], "code.threshold")
        shop_ids = frozenset(raw["shop_ids"])
        if kind == "percent":
            percent = raw["percent"]
            if isinstance(percent, bool) or not isinstance(percent, int):
                raise ValueError(f"百分比券 {cid!r} 的 percent 必须为整数")
            if not 1 <= percent <= 50:
                raise ValueError(f"百分比券 {cid!r} 的比例必须在 1..50: {percent}")
            result.append(Coupon(cid, shop_ids, threshold, "percent", percent=percent))
        elif kind == "fixed":
            value = _require_int(raw["value"], "code.value")
            result.append(Coupon(cid, shop_ids, threshold, "fixed", value=value))
        else:
            raise ValueError(f"未知优惠券类型: {kind!r}")
    return result


def compute_store_stages(
    store: Store,
    promo: Optional[Promo],
    percent_coupon: Optional[Coupon],
    fixed_coupon: Optional[Coupon],
) -> dict:
    """按 满减 -> 百分比券 -> 固定券 -> 运费 的顺序核算单店各阶段金额。

    每一步的门槛都用该步执行前的商品金额判断；满减与固定券不把金额减到负数。
    返回各阶段金额、运费、单店实付，以及实际生效的各档选择（门槛未达则为 None）。
    """
    amount = store.subtotal
    stages = {"original": amount}

    used_promo = None
    if promo is not None and amount >= promo.threshold:
        amount = max(0, amount - promo.discount)
        used_promo = promo
    stages["after_promo"] = amount

    used_percent = None
    if percent_coupon is not None and amount >= percent_coupon.threshold:
        amount -= (amount * percent_coupon.percent) // 100
        used_percent = percent_coupon
    stages["after_percent"] = amount

    used_fixed = None
    if fixed_coupon is not None and amount >= fixed_coupon.threshold:
        amount = max(0, amount - fixed_coupon.value)
        used_fixed = fixed_coupon
    stages["after_fixed"] = amount

    shipping = 0 if amount >= store.free_shipping_threshold else store.shipping
    stages["shipping"] = shipping
    stages["total"] = amount + shipping
    stages["applied"] = {
        "promo": used_promo.id if used_promo else None,
        "percent_code": used_percent.id if used_percent else None,
        "fixed_code": used_fixed.id if used_fixed else None,
    }
    return stages


def evaluate(stores: Sequence[dict], codes: Sequence[dict], plan: dict) -> dict:
    """核算指定方案；非法方案抛出 InvalidPlanError，绝不自动修正。

    plan 形如 {store_id: {"promo": id|None, "percent_code": id|None,
    "fixed_code": id|None}}。所有金额均从 stores/codes 重算，不信 plan 中的金额。
    """
    store_list = parse_stores(stores)
    coupon_list = parse_coupons(codes)
    coupons_by_id = {c.id: c for c in coupon_list}
    store_ids = {s.id for s in store_list}

    for sid in plan:
        if sid not in store_ids:
            raise InvalidPlanError(f"plan 包含未知店铺: {sid!r}")

    used_coupons: Dict[str, str] = {}  # coupon_id -> store_id
    store_results = {}
    grand_total = 0

    for store in store_list:
        entry = plan.get(store.id) or {}
        promo_id = entry.get("promo")
        percent_id = entry.get("percent_code")
        fixed_id = entry.get("fixed_code")

        promo = None
        if promo_id is not None:
            promo = next((p for p in store.promos if p.id == promo_id), None)
            if promo is None:
                raise InvalidPlanError(
                    f"店铺 {store.id!r} 不存在满减活动 {promo_id!r}"
                )

        def _take_coupon(cid, expect_kind, slot):
            coupon = coupons_by_id.get(cid)
            if coupon is None:
                raise InvalidPlanError(f"未知优惠券: {cid!r}")
            if coupon.kind != expect_kind:
                raise InvalidPlanError(
                    f"优惠券 {cid!r} 类型为 {coupon.kind}，不能用于 {slot} 槽位"
                )
            if store.id not in coupon.shop_ids:
                raise InvalidPlanError(
                    f"优惠券 {cid!r} 不适用于店铺 {store.id!r}"
                )
            if cid in used_coupons:
                raise InvalidPlanError(
                    f"优惠券 {cid!r} 被重复使用（店铺 {used_coupons[cid]!r} 与 "
                    f"{store.id!r}）"
                )
            return coupon

        percent_coupon = (
            _take_coupon(percent_id, "percent", "百分比") if percent_id is not None else None
        )
        fixed_coupon = (
            _take_coupon(fixed_id, "fixed", "固定") if fixed_id is not None else None
        )

        stages = compute_store_stages(store, promo, percent_coupon, fixed_coupon)
        applied = stages["applied"]

        # 方案指定的每一项都必须真正生效（门槛满足），否则为非法方案。
        if promo_id is not None and applied["promo"] != promo_id:
            raise InvalidPlanError(
                f"店铺 {store.id!r} 满减 {promo_id!r} 门槛不满足"
            )
        if percent_id is not None and applied["percent_code"] != percent_id:
            raise InvalidPlanError(
                f"店铺 {store.id!r} 百分比券 {percent_id!r} 门槛不满足"
            )
        if fixed_id is not None and applied["fixed_code"] != fixed_id:
            raise InvalidPlanError(
                f"店铺 {store.id!r} 固定券 {fixed_id!r} 门槛不满足"
            )

        for cid in (percent_id, fixed_id):
            if cid is not None:
                used_coupons[cid] = store.id

        store_results[store.id] = stages
        grand_total += stages["total"]

    return {
        "plan": {
            s.id: dict(store_results[s.id]["applied"]) for s in store_list
        },
        "stores": store_results,
        "total": grand_total,
    }
