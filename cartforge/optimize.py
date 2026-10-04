"""quote：跨店最优优惠选择（精确 DP，非启发式）。

算法：把 12 张券的全局分配建模为位掩码 DP。
每店的局部选择只有 O(券对) 种（不选 / 单张 / 百分比+固定各一张），
对每种券组合再枚举该店全部满减活动取最优，因此：
- 不先固定局部最优再分券（券分配与店内选择联合优化）；
- 不做笛卡尔积全量遍历（复杂度 O(店数 * 3^券数) 量级，实际为
  O(店数 * 2^券数 * 每店券组合数)）；
- 全部整数运算，无浮点。
"""
from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

from .core import (
    Coupon,
    Store,
    compute_store_stages,
    parse_coupons,
    parse_stores,
)

_INF = 1 << 62


def _store_options(
    store: Store, coupons: Sequence[Coupon]
) -> List[Tuple[int, int, Optional[str], Optional[str], Optional[str]]]:
    """枚举该店所有候选：(券掩码, 最低实付, 满减id, 百分比券id, 固定券id)。

    券组合只可能有：不选 / 单张百分比 / 单张固定 / 百分比+固定。
    对每个券组合枚举全部满减活动（含不选），取该组合下的最低实付。
    相同券掩码只保留费用最低的一项。
    """
    idx = {c.id: i for i, c in enumerate(coupons)}
    percents = [c for c in coupons if c.kind == "percent" and store.id in c.shop_ids]
    fixeds = [c for c in coupons if c.kind == "fixed" and store.id in c.shop_ids]

    combos: List[Tuple[Optional[Coupon], Optional[Coupon]]] = [(None, None)]
    combos += [(p, None) for p in percents]
    combos += [(None, f) for f in fixeds]
    combos += [(p, f) for p in percents for f in fixeds]

    promos: List = [None] + list(store.promos)
    best = {}
    for pct, fix in combos:
        for promo in promos:
            stages = compute_store_stages(store, promo, pct, fix)
            applied = stages["applied"]
            mask = 0
            if applied["percent_code"] is not None:
                mask |= 1 << idx[applied["percent_code"]]
            if applied["fixed_code"] is not None:
                mask |= 1 << idx[applied["fixed_code"]]
            key = mask
            cand = (
                stages["total"],
                applied["promo"],
                applied["percent_code"],
                applied["fixed_code"],
            )
            if key not in best or cand[0] < best[key][0]:
                best[key] = cand
    return [(mask,) + cand for mask, cand in best.items()]


def quote(stores: Sequence[dict], codes: Sequence[dict]) -> dict:
    """返回总实付最低的合法方案及每店各阶段明细。"""
    store_list = parse_stores(stores)
    coupon_list = parse_coupons(codes)
    n_coupons = len(coupon_list)
    if n_coupons > 24:
        raise ValueError("优惠券数量超出支持规模（<=24）")
    size = 1 << n_coupons

    dp = [_INF] * size
    dp[0] = 0
    # 每层记录父状态以便回溯：prev_mask 与所选 option 的下标。
    parents: List[Tuple[list, list]] = []
    options_per_store = []

    for store in store_list:
        options = _store_options(store, coupon_list)
        options_per_store.append(options)
        used_masks = [o[0] for o in options]
        costs = [o[1] for o in options]
        n_opts = len(options)
        new = [_INF] * size
        par_prev = [-1] * size
        par_opt = [-1] * size
        for mask in range(size):
            base = dp[mask]
            if base == _INF:
                continue
            for i in range(n_opts):
                used = used_masks[i]
                if used & mask:
                    continue
                m2 = mask | used
                val = base + costs[i]
                if val < new[m2]:
                    new[m2] = val
                    par_prev[m2] = mask
                    par_opt[m2] = i
        dp = new
        parents.append((par_prev, par_opt))

    # 取总实付最低的终点（允许券未用完）。
    best_mask = min(range(size), key=lambda m: dp[m])
    grand_total = dp[best_mask]

    # 回溯得到每店选择的 option。
    chosen: List[Optional[tuple]] = [None] * len(store_list)
    mask = best_mask
    for s in range(len(store_list) - 1, -1, -1):
        par_prev, par_opt = parents[s]
        opt_idx = par_opt[mask]
        chosen[s] = options_per_store[s][opt_idx]
        mask = par_prev[mask]

    coupons_by_id = {c.id: c for c in coupon_list}
    plan = {}
    store_results = {}
    for store, opt in zip(store_list, chosen):
        _, _, promo_id, pct_id, fix_id = opt
        promo = next((p for p in store.promos if p.id == promo_id), None)
        pct = coupons_by_id.get(pct_id) if pct_id else None
        fix = coupons_by_id.get(fix_id) if fix_id else None
        stages = compute_store_stages(store, promo, pct, fix)
        plan[store.id] = dict(stages["applied"])
        store_results[store.id] = stages

    return {"plan": plan, "stores": store_results, "total": grand_total}
