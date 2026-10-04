import unittest

from brand_pulse import NegativeAlertIndex, WINDOW_MS

W = WINDOW_MS  # 3600000


class NegativeAlertIndexTest(unittest.TestCase):
    def test_basic_single_mention_span(self):
        idx = NegativeAlertIndex(0)
        idx.ingest("a", 1000, -0.5)
        self.assertEqual(idx.spans(0, 10_000_000), [(1000, 1000 + W)])

    def test_score_exactly_minus_0_3_is_not_negative(self):
        idx = NegativeAlertIndex(0)
        idx.ingest("a", 0, -0.3)
        self.assertEqual(idx.spans(0, 10_000_000), [])
        idx.rescore("a", -0.3000001)
        self.assertEqual(idx.spans(0, 10_000_000), [(0, W)])

    def test_same_millisecond_multiple_mentions_and_exactly_k(self):
        # K=2: three negative mentions at the same ms push C to 3 > 2.
        idx = NegativeAlertIndex(2)
        idx.ingest("a", 500, -0.5)
        idx.ingest("b", 500, -0.6)
        self.assertEqual(idx.spans(0, 10_000_000), [])  # C == K, no alert
        idx.ingest("c", 500, -0.7)
        self.assertEqual(idx.spans(0, 10_000_000), [(500, 500 + W)])

    def test_distinct_ids_same_time_and_score_count_separately(self):
        idx = NegativeAlertIndex(1)
        idx.ingest("a", 0, -0.9)
        idx.ingest("b", 0, -0.9)
        self.assertEqual(idx.spans(0, 10_000_000), [(0, W)])

    def test_duplicate_ingest_is_noop_and_does_not_override_rescore(self):
        idx = NegativeAlertIndex(0)
        idx.ingest("a", 100, -0.5)
        idx.rescore("a", 0.0)  # now neutral
        idx.ingest("a", 200, -0.9)  # must be ignored entirely
        self.assertEqual(idx.spans(0, 10_000_000), [])
        # Timestamp is fixed by first ingest too.
        idx.rescore("a", -0.9)
        self.assertEqual(idx.spans(0, 10_000_000), [(100, 100 + W)])

    def test_rescore_unknown_id_is_noop(self):
        idx = NegativeAlertIndex(0)
        idx.rescore("ghost", -0.9)
        self.assertEqual(idx.spans(0, 10_000_000), [])

    def test_out_of_order_ingest(self):
        idx = NegativeAlertIndex(0)
        idx.ingest("late", 5000, -0.5)
        idx.ingest("early", 1000, -0.5)
        # Windows overlap, so the maximal span merges them.
        self.assertEqual(idx.spans(0, 10_000_000), [(1000, 5000 + W)])

    def test_expiry_and_entry_same_millisecond_no_gap_no_overlap(self):
        # Batch A expires exactly when batch B enters: alert continues
        # seamlessly with no zero-length interval and no false gap.
        idx = NegativeAlertIndex(1)
        idx.ingest("a1", 0, -0.5)
        idx.ingest("a2", 0, -0.5)
        idx.ingest("b1", W, -0.5)
        idx.ingest("b2", W, -0.5)
        self.assertEqual(idx.spans(0, 10 * W), [(0, 2 * W)])

    def test_alert_can_end_by_expiry_without_new_mentions(self):
        idx = NegativeAlertIndex(0)
        idx.ingest("a", 2000, -0.4)
        self.assertEqual(idx.spans(0, 10 * W), [(2000, 2000 + W)])

    def test_spans_clipped_to_query_range(self):
        idx = NegativeAlertIndex(0)
        idx.ingest("a", 1000, -0.5)
        self.assertEqual(idx.spans(0, 500), [])
        self.assertEqual(idx.spans(2000, 3000), [(2000, 3000)])
        self.assertEqual(idx.spans(500, 1000 + W + 500), [(1000, 1000 + W)])

    def test_empty_or_inverted_query_range(self):
        idx = NegativeAlertIndex(0)
        idx.ingest("a", 0, -0.5)
        self.assertEqual(idx.spans(100, 100), [])
        self.assertEqual(idx.spans(200, 100), [])

    def test_adjacent_alert_intervals_merge(self):
        # Two overlapping alert periods merge into one maximal interval.
        idx = NegativeAlertIndex(0)
        idx.ingest("a", 0, -0.5)
        idx.ingest("b", W // 2, -0.5)
        self.assertEqual(idx.spans(0, 10 * W), [(0, W // 2 + W)])

    def test_rescore_to_neutral_splits_span_and_restore_merges(self):
        # K=0: three back-to-back mentions form one continuous alert span.
        # Neutralizing the middle one splits it; restoring re-merges.
        idx = NegativeAlertIndex(0)
        idx.ingest("a", 0, -0.5)
        idx.ingest("b", W, -0.5)
        idx.ingest("c", 2 * W, -0.5)
        self.assertEqual(idx.spans(0, 10 * W), [(0, 3 * W)])

        idx.rescore("b", 0.0)  # negative -> neutral
        self.assertEqual(
            idx.spans(0, 10 * W),
            [(0, W), (2 * W, 3 * W)],
        )

        idx.rescore("b", -0.6)  # restore negative
        self.assertEqual(idx.spans(0, 10 * W), [(0, 3 * W)])

    def test_rescore_retroactively_affects_history(self):
        # A rescore changes windows entirely in the "past" relative to
        # other operations already performed.
        idx = NegativeAlertIndex(0)
        idx.ingest("a", 100, 0.0)  # neutral at ingest time
        self.assertEqual(idx.spans(0, 10 * W), [])
        idx.rescore("a", -0.5)
        self.assertEqual(idx.spans(0, 10 * W), [(100, 100 + W)])

    def test_interleaved_operations(self):
        idx = NegativeAlertIndex(1)
        idx.ingest("a", 0, -0.5)
        self.assertEqual(idx.spans(0, 10 * W), [])
        idx.ingest("b", 100, -0.5)
        self.assertEqual(idx.spans(0, 10 * W), [(100, W)])
        idx.rescore("a", 0.5)
        self.assertEqual(idx.spans(0, 10 * W), [])
        idx.rescore("a", -0.5)
        idx.ingest("c", W, -0.5)  # enters exactly as a expires
        # C > 1 holds on [100, W) via a+b and on [W, W+100) via b+c;
        # adjacent segments merge into one maximal span.
        self.assertEqual(idx.spans(0, 10 * W), [(100, W + 100)])

    def test_invalid_k_rejected(self):
        for bad in (-1, 1.5, "1", None, True):
            with self.assertRaises(ValueError):
                NegativeAlertIndex(bad)


if __name__ == "__main__":
    unittest.main()
