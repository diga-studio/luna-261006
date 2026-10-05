// Standalone memory check, executed as a child process by memory.test.ts so
// that heap measurements are not polluted by the test-runner harness.
// Prints a JSON summary line and exits non-zero when any bound is violated.
import { createDetector } from "../src/detector.ts";
import type { TelemetryEvent } from "../src/types.ts";

const gc = (globalThis as { gc?: () => void }).gc;

function heapMb(): number {
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

const W = 1_000;
const LIMIT_MB = 32;

const detector = createDetector([
  {
    ruleId: "mem",
    windowMs: W,
    stages: Array.from({ length: 8 }, () => ({ eventType: "EV" })),
  },
]);

let clock = 0;
let id = 0;
const nextEvent = (agentId: string): TelemetryEvent => {
  id += 1;
  clock += 1;
  return { eventId: `m${id}`, agentId, ts: clock, eventType: "EV" };
};

const baseline = heapMb();
const roundHeaps: number[] = [];

// Three rounds of heavy traffic, each fully flushed afterwards. Retained
// memory must return to baseline every round.
for (let round = 0; round < 3; round++) {
  let batch: TelemetryEvent[] = [];
  for (let n = 0; n < 50_000; n++) {
    batch.push(nextEvent("hot-agent"));
    if (batch.length === 4096) {
      detector.ingest(batch);
      batch = [];
    }
  }
  if (batch.length > 0) detector.ingest(batch);
  detector.advanceTo(clock + W + 1); // push every window out of scope
  clock += W + 1; // time only moves forward
  roundHeaps.push(heapMb());
}

// Many agents that all go idle must not leave cumulative state behind.
for (let a = 0; a < 20_000; a++) {
  detector.ingest([nextEvent(`agent-${a}`), nextEvent(`agent-${a}`)]);
}
detector.advanceTo(clock + W + 1);
const afterIdleAgents = heapMb();

const failures: string[] = [];
for (const [i, heap] of roundHeaps.entries()) {
  if (heap >= baseline + LIMIT_MB) {
    failures.push(`round ${i} retains ${(heap - baseline).toFixed(1)}MB above baseline`);
  }
}
if (afterIdleAgents >= baseline + LIMIT_MB) {
  failures.push(
    `idle agents retain ${(afterIdleAgents - baseline).toFixed(1)}MB above baseline`,
  );
}

const fmt = (m: number) => m.toFixed(1);
console.log(
  `memory: baseline=${fmt(baseline)}MB ` +
    `rounds=[${roundHeaps.map(fmt).join(", ")}]MB ` +
    `afterIdleAgents=${fmt(afterIdleAgents)}MB`,
);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
