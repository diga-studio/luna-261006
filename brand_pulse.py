"""Brand Pulse: single-brand rolling negative-mention alert index.

In-memory only. Sentiment scores are supplied by the caller; this module
performs no text analysis. All operations are called serially.

Alerts are computed from the latest scores at query time: rescoring can
retroactively remove, shorten, split, or merge historical alert spans.
"""

WINDOW_MS = 3600000
NEGATIVE_THRESHOLD = -0.3


class BrandPulseIndex:
    """Rolling alert index for one brand.

    An alert holds at integer millisecond x when C(x) > K, where C(x) is the
    number of distinct currently-negative mention IDs with
    timestamp_ms <= x < timestamp_ms + WINDOW_MS.
    """

    def __init__(self, k: int) -> None:
        if not isinstance(k, int) or isinstance(k, bool) or k < 0:
            raise ValueError("k must be a non-negative integer")
        self._k = k
        # mention_id -> (timestamp_ms, score); timestamp is fixed at first ingest.
        self._mentions = {}

    def ingest(self, mention_id, timestamp_ms: int, score: float) -> None:
        """Import a mention. Re-importing an existing ID is a no-op and never
        overwrites a rescored value or the original timestamp."""
        if mention_id in self._mentions:
            return
        self._mentions[mention_id] = (timestamp_ms, score)

    def rescore(self, mention_id, score: float) -> None:
        """Replace the current score of an existing mention, affecting all
        historical windows immediately. Unknown IDs are ignored."""
        entry = self._mentions.get(mention_id)
        if entry is None:
            return
        self._mentions[mention_id] = (entry[0], score)

    def spans(self, begin_ms: int, end_ms: int) -> list:
        """Return the maximal half-open intervals within [begin_ms, end_ms)
        where C(x) > K. Intervals are clipped to the query range, non-
        overlapping, and adjacent intervals are merged."""
        if end_ms <= begin_ms:
            return []

        window = WINDOW_MS
        count = 0
        deltas = {}
        for timestamp_ms, score in self._mentions.values():
            if not score < NEGATIVE_THRESHOLD:
                continue
            expiry = timestamp_ms + window
            if timestamp_ms <= begin_ms < expiry:
                count += 1
            if begin_ms < timestamp_ms < end_ms:
                deltas[timestamp_ms] = deltas.get(timestamp_ms, 0) + 1
            if begin_ms < expiry < end_ms:
                deltas[expiry] = deltas.get(expiry, 0) - 1

        result = []
        open_start = begin_ms if count > self._k else None
        for time_ms in sorted(deltas):
            # Entries and expiries at the same millisecond net out together,
            # so they never create transient alerts or false gaps.
            count += deltas[time_ms]
            if count > self._k:
                if open_start is None:
                    open_start = time_ms
            elif open_start is not None:
                result.append((open_start, time_ms))
                open_start = None
        if open_start is not None:
            result.append((open_start, end_ms))
        return result
