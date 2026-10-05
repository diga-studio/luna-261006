import {
  BehaviorRecord,
  INTERVAL_LENGTH_MS,
  IntervalVerdict,
  MethodStats,
  ObservationReport,
  PointConclusion,
  RecordId,
  SAMPLING_OFFSET_MS,
} from "./types";

function assertPositiveIntegerMs(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer millisecond value`);
  }
}

export class BehaviorTimeline {
  private readonly records = new Map<RecordId, BehaviorRecord>();
  readonly intervalCount: number;

  constructor(readonly totalLengthMs: number) {
    assertPositiveIntegerMs(totalLengthMs, "totalLengthMs");
    if (totalLengthMs === 0 || totalLengthMs % INTERVAL_LENGTH_MS !== 0) {
      throw new RangeError(
        `totalLengthMs must be a positive multiple of ${INTERVAL_LENGTH_MS}`,
      );
    }
    this.intervalCount = totalLengthMs / INTERVAL_LENGTH_MS;
  }

  submit(record: BehaviorRecord): void {
    assertPositiveIntegerMs(record.startMs, "record.startMs");
    assertPositiveIntegerMs(record.endMs, "record.endMs");
    if (record.startMs >= record.endMs) {
      throw new RangeError("record.startMs must be less than record.endMs");
    }
    if (record.endMs > this.totalLengthMs) {
      throw new RangeError("record range exceeds the timeline length");
    }
    this.records.set(record.id, {
      id: record.id,
      startMs: record.startMs,
      endMs: record.endMs,
      occurred: record.occurred,
    });
  }

  retract(id: RecordId): void {
    this.records.delete(id);
  }

  report(fromInterval: number, toInterval: number): ObservationReport {
    if (
      !Number.isInteger(fromInterval) ||
      !Number.isInteger(toInterval) ||
      fromInterval < 0 ||
      toInterval > this.intervalCount ||
      fromInterval >= toInterval
    ) {
      throw new RangeError(
        `report range must satisfy 0 <= fromInterval < toInterval <= ${this.intervalCount}`,
      );
    }
    const whole: IntervalVerdict[] = [];
    const partial: IntervalVerdict[] = [];
    const sampling: IntervalVerdict[] = [];
    for (let i = fromInterval; i < toInterval; i += 1) {
      const start = i * INTERVAL_LENGTH_MS;
      const end = start + INTERVAL_LENGTH_MS;
      const segments = this.segmentConclusions(start, end);
      whole.push(wholeIntervalVerdict(segments));
      partial.push(partialIntervalVerdict(segments));
      sampling.push(this.pointConclusion(start + SAMPLING_OFFSET_MS));
    }
    return {
      wholeInterval: summarize(whole),
      partialInterval: summarize(partial),
      momentarySampling: summarize(sampling),
    };
  }

  pointConclusion(atMs: number): PointConclusion {
    let hasOccurred = false;
    let hasNotOccurred = false;
    for (const record of this.records.values()) {
      if (record.startMs <= atMs && atMs < record.endMs) {
        if (record.occurred) {
          hasOccurred = true;
        } else {
          hasNotOccurred = true;
        }
      }
    }
    if (hasOccurred && !hasNotOccurred) {
      return "occurred";
    }
    if (hasNotOccurred && !hasOccurred) {
      return "notOccurred";
    }
    return "unknown";
  }

  private segmentConclusions(startMs: number, endMs: number): PointConclusion[] {
    const cuts = new Set<number>([startMs, endMs]);
    for (const record of this.records.values()) {
      if (record.endMs <= startMs || record.startMs >= endMs) {
        continue;
      }
      if (record.startMs > startMs) {
        cuts.add(record.startMs);
      }
      if (record.endMs < endMs) {
        cuts.add(record.endMs);
      }
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    const conclusions: PointConclusion[] = [];
    for (let i = 0; i + 1 < sorted.length; i += 1) {
      conclusions.push(this.pointConclusion(sorted[i]));
    }
    return conclusions;
  }
}

function wholeIntervalVerdict(segments: PointConclusion[]): IntervalVerdict {
  if (segments.some((c) => c === "notOccurred")) {
    return "notOccurred";
  }
  if (segments.every((c) => c === "occurred")) {
    return "occurred";
  }
  return "unknown";
}

function partialIntervalVerdict(segments: PointConclusion[]): IntervalVerdict {
  if (segments.some((c) => c === "occurred")) {
    return "occurred";
  }
  if (segments.every((c) => c === "notOccurred")) {
    return "notOccurred";
  }
  return "unknown";
}

function summarize(verdicts: IntervalVerdict[]): MethodStats {
  let occurred = 0;
  let notOccurred = 0;
  let unknown = 0;
  for (const verdict of verdicts) {
    if (verdict === "occurred") {
      occurred += 1;
    } else if (verdict === "notOccurred") {
      notOccurred += 1;
    } else {
      unknown += 1;
    }
  }
  const decidable = occurred + notOccurred;
  return {
    occurred,
    notOccurred,
    unknown,
    occurredRatio: decidable === 0 ? null : occurred / decidable,
  };
}
