import {
  INTERVAL_MS,
  IntervalState,
  Method,
  MethodStats,
  RangeReport,
  SAMPLE_OFFSET_MS,
} from "./types";
import { ObservationTimeline } from "./observation";

export { INTERVAL_MS, SAMPLE_OFFSET_MS } from "./types";

/** 判定单个区间在指定方法下的结果 */
export function classifyInterval(
  timeline: ObservationTimeline,
  intervalIndex: number,
  method: Method,
): IntervalState {
  const startMs = intervalIndex * INTERVAL_MS;
  const endMs = startMs + INTERVAL_MS;

  if (method === "momentary") {
    return timeline.stateAt(startMs + SAMPLE_OFFSET_MS);
  }

  let anyOccurred = false;
  let anyNotOccurred = false;
  let anyUnknown = false;
  for (let t = startMs; t < endMs; t += 1) {
    const state = timeline.stateAt(t);
    if (state === "occurred") {
      anyOccurred = true;
    } else if (state === "notOccurred") {
      anyNotOccurred = true;
    } else {
      anyUnknown = true;
    }
    if (method === "whole" && anyNotOccurred) {
      return "notOccurred";
    }
    if (method === "partial" && anyOccurred) {
      return "occurred";
    }
  }

  if (method === "whole") {
    if (!anyNotOccurred && !anyUnknown) {
      return "occurred";
    }
    return "unknown";
  }
  if (!anyOccurred && !anyUnknown) {
    return "notOccurred";
  }
  return "unknown";
}

function emptyStats(): MethodStats {
  return { occurred: 0, notOccurred: 0, unknown: 0, occurredRatio: null };
}

function tally(stats: MethodStats, state: IntervalState): void {
  if (state === "occurred") {
    stats.occurred += 1;
  } else if (state === "notOccurred") {
    stats.notOccurred += 1;
  } else {
    stats.unknown += 1;
  }
}

function finalize(stats: MethodStats): MethodStats {
  const decidable = stats.occurred + stats.notOccurred;
  stats.occurredRatio = decidable === 0 ? null : stats.occurred / decidable;
  return stats;
}

/** 生成范围报告；范围按完整区间指定 [fromInterval, toInterval) */
export function buildReport(
  timeline: ObservationTimeline,
  fromInterval: number,
  toInterval: number,
): RangeReport {
  if (
    !Number.isInteger(fromInterval) ||
    !Number.isInteger(toInterval) ||
    fromInterval < 0 ||
    toInterval > timeline.intervalCount ||
    fromInterval >= toInterval
  ) {
    throw new RangeError(
      `非法区间范围 [${fromInterval}, ${toInterval})，区间总数 ${timeline.intervalCount}`,
    );
  }

  const whole = emptyStats();
  const partial = emptyStats();
  const momentary = emptyStats();
  for (let i = fromInterval; i < toInterval; i += 1) {
    tally(whole, classifyInterval(timeline, i, "whole"));
    tally(partial, classifyInterval(timeline, i, "partial"));
    tally(momentary, classifyInterval(timeline, i, "momentary"));
  }
  return {
    whole: finalize(whole),
    partial: finalize(partial),
    momentary: finalize(momentary),
  };
}
