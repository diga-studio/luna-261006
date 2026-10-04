"""learning_recommender 的自动化测试。

包含针对指定规则的确定性场景测试，
以及与独立全量参考实现逐项对照的随机化测试。
"""

from __future__ import annotations

import math
import random
import unittest
from decimal import ROUND_HALF_UP, Decimal

from learning_recommender import LearningRecommender

_QUANT = Decimal("0.00000001")


def round8(value: float) -> Decimal:
    return Decimal(repr(value)).quantize(_QUANT, rounding=ROUND_HALF_UP)


def reference_recommend(
    evidence: dict[str, dict[str, int]],
    published: dict[str, bool],
    learner_id: str,
) -> list[str]:
    """独立的全量参考实现：直接从原始数据计算前 10 推荐。"""
    target = evidence.get(learner_id, {})
    target_norm_sq = sum(w * w for w in target.values())
    neighbors: list[tuple[str, Decimal]] = []
    for other_id, other in evidence.items():
        if other_id == learner_id:
            continue
        other_norm_sq = sum(w * w for w in other.values())
        if target_norm_sq == 0 or other_norm_sq == 0:
            continue
        contents = set(target) | set(other)
        dot = sum(target.get(c, 0) * other.get(c, 0) for c in contents)
        if dot <= 0:
            continue
        sim = round8(dot / math.sqrt(target_norm_sq * other_norm_sq))
        if sim > 0:
            neighbors.append((other_id, sim))
    neighbors.sort(key=lambda item: (-item[1], item[0]))
    neighbors = neighbors[:20]
    if not neighbors:
        return []
    scores: dict[str, Decimal] = {}
    for other_id, sim in neighbors:
        for content_id, weight in evidence.get(other_id, {}).items():
            if not published.get(content_id, False):
                continue
            if target.get(content_id, 0) != 0:
                continue
            scores[content_id] = scores.get(content_id, Decimal(0)) + sim * weight
    ranked = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    return [content_id for content_id, _ in ranked[:10]]


class BasicRulesTest(unittest.TestCase):
    def test_basic_recommendation(self) -> None:
        r = LearningRecommender()
        r.set_evidence("alice", "c1", 3)
        r.set_evidence("bob", "c1", 3)
        r.set_evidence("bob", "c2", 1)
        r.set_published("c2", True)
        self.assertEqual(r.recommend("alice"), ["c2"])

    def test_overwrite_not_accumulate(self) -> None:
        r = LearningRecommender()
        r.set_evidence("alice", "c1", 1)
        r.set_evidence("alice", "c1", 3)
        r.set_evidence("bob", "c1", 3)
        r.set_evidence("bob", "c2", 3)
        r.set_published("c2", True)
        self.assertEqual(r.recommend("alice"), ["c2"])
        r.set_evidence("alice", "c1", 0)
        self.assertEqual(r.recommend("alice"), [])

    def test_unpublished_content_not_candidate(self) -> None:
        r = LearningRecommender()
        r.set_evidence("alice", "c1", 3)
        r.set_evidence("bob", "c1", 3)
        r.set_evidence("bob", "c2", 3)
        self.assertEqual(r.recommend("alice"), [])

    def test_no_neighbors_returns_empty(self) -> None:
        r = LearningRecommender()
        r.set_evidence("alice", "c1", 3)
        r.set_evidence("bob", "c2", 3)
        r.set_published("c2", True)
        self.assertEqual(r.recommend("alice"), [])

    def test_invalid_weight_rejected(self) -> None:
        r = LearningRecommender()
        with self.assertRaises(ValueError):
            r.set_evidence("alice", "c1", 2)

    def test_score_ordering_and_tiebreak(self) -> None:
        r = LearningRecommender()
        r.set_evidence("t", "base", 3)
        r.set_evidence("n1", "base", 3)
        r.set_evidence("n2", "base", 3)
        r.set_evidence("n1", "cA", 3)
        r.set_evidence("n1", "cB", 1)
        r.set_evidence("n2", "cB", 3)
        r.set_published("cA", True)
        r.set_published("cB", True)
        self.assertEqual(r.recommend("t"), ["cB", "cA"])
        r2 = LearningRecommender()
        r2.set_evidence("t", "base", 3)
        r2.set_evidence("n1", "base", 3)
        r2.set_evidence("n1", "zeta", 3)
        r2.set_evidence("n1", "alpha", 3)
        r2.set_published("zeta", True)
        r2.set_published("alpha", True)
        self.assertEqual(r2.recommend("t"), ["alpha", "zeta"])


class NeighborBoundaryTest(unittest.TestCase):
    """非共同内容改写使邻居跨越第 20 名边界。"""

    def _build(self) -> LearningRecommender:
        r = LearningRecommender()
        r.set_evidence("target", "shared", 3)
        for i in range(1, 22):
            nid = f"n{i:02d}"
            r.set_evidence(nid, "shared", 3)
            r.set_evidence(nid, f"uniq{i:02d}", 1)
        r.set_evidence("n20", "cand20", 3)
        r.set_evidence("n21", "cand21", 3)
        r.set_published("cand20", True)
        r.set_published("cand21", True)
        return r

    def test_boundary_crossing(self) -> None:
        r = self._build()
        self.assertIn("cand20", r.recommend("target"))
        self.assertNotIn("cand21", r.recommend("target"))
        r.set_evidence("n20", "uniq20", 3)
        self.assertNotIn("cand20", r.recommend("target"))
        self.assertIn("cand21", r.recommend("target"))
        r.set_evidence("n20", "uniq20", 1)
        self.assertIn("cand20", r.recommend("target"))
        self.assertNotIn("cand21", r.recommend("target"))


class PublishToggleTest(unittest.TestCase):
    """内容下线再上线，邻居不变而候选资格正确变化。"""

    def test_unpublish_and_republish(self) -> None:
        r = LearningRecommender()
        r.set_evidence("target", "shared", 3)
        r.set_evidence("n1", "shared", 3)
        r.set_evidence("n1", "cand", 3)
        r.set_published("cand", True)
        before = r.recommend("target")
        self.assertEqual(before, ["cand"])
        r.set_published("cand", False)
        self.assertEqual(r.recommend("target"), [])
        r.set_published("cand", True)
        self.assertEqual(r.recommend("target"), before)


class RandomizedCrossCheckTest(unittest.TestCase):
    """随机操作序列下，库的结果须与独立全量计算逐项一致。"""

    def test_random_operations_match_reference(self) -> None:
        rng = random.Random(20261006)
        learners = [f"L{i}" for i in range(8)]
        contents = [f"C{i}" for i in range(10)]
        for trial in range(30):
            r = LearningRecommender()
            evidence: dict[str, dict[str, int]] = {}
            published: dict[str, bool] = {}
            for _ in range(120):
                op = rng.randrange(3)
                if op == 0:
                    lid = rng.choice(learners)
                    cid = rng.choice(contents)
                    w = rng.choice([0, 1, 3])
                    r.set_evidence(lid, cid, w)
                    if w == 0:
                        evidence.get(lid, {}).pop(cid, None)
                    else:
                        evidence.setdefault(lid, {})[cid] = w
                elif op == 1:
                    cid = rng.choice(contents)
                    flag = rng.random() < 0.7
                    r.set_published(cid, flag)
                    published[cid] = flag
                else:
                    lid = rng.choice(learners)
                    expected = reference_recommend(evidence, published, lid)
                    actual = r.recommend(lid)
                    self.assertEqual(
                        actual,
                        expected,
                        f"trial={trial} learner={lid} "
                        f"evidence={evidence} published={published}",
                    )


if __name__ == "__main__":
    unittest.main()
