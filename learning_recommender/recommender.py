"""学习内容推荐库：基于学习者相似度的内存推荐引擎。"""

from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal

_QUANT = Decimal("0.00000001")

_VALID_WEIGHTS = (0, 1, 3)


def _round8(value: float) -> Decimal:
    """四舍五入到小数点后 8 位（ROUND_HALF_UP）。"""
    return Decimal(repr(value)).quantize(_QUANT, rounding=ROUND_HALF_UP)


class LearningRecommender:
    """进程内存中的学习内容推荐器。

    - 学习证据：每对 (学习者, 内容) 只有一个当前权重，0/1/3。
    - 发布状态：内容初始为未发布。
    - 推荐：先选邻居（相似度前 20），再筛选候选内容并打分排序。
    """

    def __init__(self) -> None:
        # learner_id -> {content_id: weight}，仅存权重大于 0 的记录
        self._evidence: dict[str, dict[str, int]] = {}
        # content_id -> 是否已发布，缺失视为未发布
        self._published: dict[str, bool] = {}

    def set_evidence(self, learner_id: str, content_id: str, weight: int) -> None:
        """替换某学习者对某内容的当前学习证据权重（0/1/3）。"""
        if weight not in _VALID_WEIGHTS:
            raise ValueError(f"weight 必须是 0/1/3，收到: {weight!r}")
        weights = self._evidence.setdefault(learner_id, {})
        if weight == 0:
            weights.pop(content_id, None)
            if not weights:
                self._evidence.pop(learner_id, None)
        else:
            weights[content_id] = weight

    def set_published(self, content_id: str, published: bool) -> None:
        """修改内容发布状态。"""
        self._published[content_id] = bool(published)

    def recommend(self, learner_id: str) -> list[str]:
        """返回某学习者的前 10 篇推荐内容 ID。"""
        neighbors = self._select_neighbors(learner_id)
        if not neighbors:
            return []
        target_weights = self._evidence.get(learner_id, {})
        scores: dict[str, Decimal] = {}
        for neighbor_id, similarity in neighbors:
            for content_id, weight in self._evidence.get(neighbor_id, {}).items():
                if not self._published.get(content_id, False):
                    continue
                if target_weights.get(content_id, 0) != 0:
                    continue
                contribution = similarity * weight
                scores[content_id] = scores.get(content_id, Decimal(0)) + contribution
        ranked = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
        return [content_id for content_id, _ in ranked[:10]]

    def _select_neighbors(self, learner_id: str) -> list[tuple[str, Decimal]]:
        """按已舍入相似度选出前 20 名相似度大于 0 的其他学习者。"""
        target_weights = self._evidence.get(learner_id, {})
        target_norm_sq = sum(w * w for w in target_weights.values())
        similarities: list[tuple[str, Decimal]] = []
        for other_id, other_weights in self._evidence.items():
            if other_id == learner_id:
                continue
            other_norm_sq = sum(w * w for w in other_weights.values())
            if target_norm_sq == 0 or other_norm_sq == 0:
                continue
            dot = sum(
                weight * other_weights.get(content_id, 0)
                for content_id, weight in target_weights.items()
            )
            if dot <= 0:
                continue
            similarity = dot / math.sqrt(target_norm_sq * other_norm_sq)
            rounded = _round8(similarity)
            if rounded > 0:
                similarities.append((other_id, rounded))
        similarities.sort(key=lambda item: (-item[1], item[0]))
        return similarities[:20]
