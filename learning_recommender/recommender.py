"""学习内容推荐库：基于学习者-内容权重的协同过滤推荐。

学习证据与内容发布状态均保存在进程内存中，每次查询都基于全部当前数据
直接计算，因此任何修改在下一次查询中立即生效。
"""

from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal

Weight = int  # 合法取值：0（未接触）、1（已读未通过）、3（通过测验）

_VALID_WEIGHTS = (0, 1, 3)
_NEIGHBOR_LIMIT = 20
_RECOMMEND_LIMIT = 10
_QUANT = Decimal("1e-8")


def _round8(value: float) -> float:
    """四舍五入到小数点后 8 位。"""
    return float(Decimal(repr(value)).quantize(_QUANT, rounding=ROUND_HALF_UP))


def _similarity(a: dict[str, Weight], b: dict[str, Weight]) -> float:
    """两名学习者的相似度；任一方全部权重为 0 时为 0。

    使用双方全部内容（包括已下线内容），结果四舍五入到小数点后 8 位。
    """
    sum_sq_a = sum(w * w for w in a.values())
    sum_sq_b = sum(w * w for w in b.values())
    if sum_sq_a == 0 or sum_sq_b == 0:
        return 0.0
    if len(a) <= len(b):
        dot = sum(w * b.get(k, 0) for k, w in a.items())
    else:
        dot = sum(w * a.get(k, 0) for k, w in b.items())
    if dot == 0:
        return 0.0
    return _round8(dot / math.sqrt(sum_sq_a * sum_sq_b))


class Recommender:
    """进程内存中的学习证据与内容发布状态，提供推荐查询。"""

    def __init__(self) -> None:
        # learner_id -> {content_id: weight}，仅保存非零权重
        self._weights: dict[str, dict[str, Weight]] = {}
        # 已发布内容集合；内容初始为未发布
        self._published: set[str] = set()

    def set_evidence(self, learner_id: str, content_id: str, weight: Weight) -> None:
        """替换某学习者对某内容的当前学习证据（覆盖，非累加）。

        权重改为 0 后，该内容重新成为此人的未接触内容；缺失记录按 0 计算。
        """
        if weight not in _VALID_WEIGHTS:
            raise ValueError(f"非法权重 {weight!r}，只允许 0、1、3")
        learner = self._weights.setdefault(learner_id, {})
        if weight == 0:
            learner.pop(content_id, None)
        else:
            learner[content_id] = weight

    def set_published(self, content_id: str, published: bool) -> None:
        """修改内容发布状态；内容初始为未发布。

        下线只改变候选资格，不删除学习证据；重新上线后立即恢复资格。
        """
        if published:
            self._published.add(content_id)
        else:
            self._published.discard(content_id)

    def recommend(self, learner_id: str) -> list[str]:
        """返回某学习者的前 10 篇推荐内容 ID（不足 10 篇不补齐）。

        先按已舍入相似度选取前 20 名邻居，再筛选候选内容；
        没有邻居时返回空结果。
        """
        target = self._weights.get(learner_id, {})

        neighbors: list[tuple[str, float]] = []
        for other_id, other in self._weights.items():
            if other_id == learner_id:
                continue
            sim = _similarity(target, other)
            if sim > 0:
                neighbors.append((other_id, sim))
        neighbors.sort(key=lambda item: (-item[1], item[0]))
        neighbors = neighbors[:_NEIGHBOR_LIMIT]
        if not neighbors:
            return []

        # 候选内容：已发布、目标当前权重为 0、至少一名邻居权重大于 0
        scores: dict[str, float] = {}
        for other_id, sim in neighbors:
            for content_id, weight in self._weights[other_id].items():
                if content_id not in self._published or content_id in target:
                    continue
                scores[content_id] = scores.get(content_id, 0.0) + weight * sim

        ranked = sorted(
            ((content_id, _round8(score)) for content_id, score in scores.items()),
            key=lambda item: (-item[1], item[0]),
        )
        return [content_id for content_id, _ in ranked[:_RECOMMEND_LIMIT]]
