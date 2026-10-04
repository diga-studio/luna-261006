import { test } from "node:test";
import { ok, deepEqual } from "node:assert/strict";
import { BomService } from "../src/bomService";
import { BomRevision } from "../src/types";

const clearA: BomRevision = { assemblyId: "A", startDay: 10, components: [] };
const bRefsA: BomRevision = { assemblyId: "B", startDay: 10, components: ["A"] };

for (const order of ["clear-first", "reference-first"] as const) {
  test(`same-day clear + reverse reference in one batch succeeds (${order})`, () => {
    const service = new BomService();
    ok(service.publishBatch([{ assemblyId: "A", startDay: 0, components: ["B"] }]).ok);

    const batch = order === "clear-first" ? [clearA, bRefsA] : [bRefsA, clearA];
    const result = service.publishBatch(batch);
    ok(result.ok, `batch must be judged on its final timetable, not per-insertion (${order})`);

    deepEqual(service.bomAt("A", 9), { assemblyId: "A", startDay: 0, components: ["B"] });
    deepEqual(service.bomAt("A", 10), { assemblyId: "A", startDay: 10, components: [] });
    deepEqual(service.bomAt("B", 10), { assemblyId: "B", startDay: 10, components: ["A"] });
    deepEqual(service.bomAt("B", 999), { assemblyId: "B", startDay: 10, components: ["A"] });
  });
}

test("rejected batch hides unrelated legal changes and keeps prior state intact", () => {
  const service = new BomService();
  ok(service.publishBatch([{ assemblyId: "A", startDay: 5, components: ["B"] }]).ok);

  const unrelated: BomRevision = { assemblyId: "C", startDay: 3, components: ["D"] };
  const cycling: BomRevision = { assemblyId: "B", startDay: 7, components: ["A"] };
  const result = service.publishBatch([unrelated, cycling]);
  ok(!result.ok, "B->A on day 7 while A->B is still effective must be rejected");

  deepEqual(service.bomAt("C", 3), null, "unrelated change must not become visible");
  deepEqual(service.bomAt("C", 100), null);
  deepEqual(service.bomAt("B", 7), null, "cycling change must not become visible");
  deepEqual(service.bomAt("A", 7), { assemblyId: "A", startDay: 5, components: ["B"] });
  deepEqual(service.bomAt("A", 1_000_000), { assemblyId: "A", startDay: 5, components: ["B"] });

  const retry = service.publishBatch([unrelated]);
  ok(retry.ok, "service stays fully usable after a rejected batch");
  deepEqual(service.bomAt("C", 3), { assemblyId: "C", startDay: 3, components: ["D"] });
});

test("inserting a version between two existing ones shortens the previous window", () => {
  const service = new BomService();
  ok(service.publishBatch([{ assemblyId: "A", startDay: 0, components: ["B"] }]).ok);
  ok(service.publishBatch([{ assemblyId: "A", startDay: 50, components: [] }]).ok);
  ok(service.publishBatch([{ assemblyId: "B", startDay: 100, components: ["A"] }]).ok);

  // Insert A->B at day 25: the day-0 version's window shrinks to [0,25),
  // the new version holds [25,50). Still no overlap with B->A on [100,inf).
  const accepted = service.publishBatch([{ assemblyId: "A", startDay: 25, components: ["B"] }]);
  ok(accepted.ok, "insertion that keeps clear of B->A must be accepted");
  deepEqual(service.bomAt("A", 24), { assemblyId: "A", startDay: 0, components: ["B"] });
  deepEqual(service.bomAt("A", 25), { assemblyId: "A", startDay: 25, components: ["B"] });
  deepEqual(service.bomAt("A", 50), { assemblyId: "A", startDay: 50, components: [] });

  // B->A at day 10 overlaps A->B on [10,50): the cycle closes on days that are
  // not any new version's start day, so the check must look past start days.
  const rejected = service.publishBatch([{ assemblyId: "B", startDay: 10, components: ["A"] }]);
  ok(!rejected.ok, "cycle closing inside an existing window must be rejected");
  if (!rejected.ok) {
    ok(rejected.witness.day >= 10 && rejected.witness.day < 50);
  }
  deepEqual(service.bomAt("B", 10), null, "rejected insertion leaves no trace");
  deepEqual(service.bomAt("B", 100), { assemblyId: "B", startDay: 100, components: ["A"] });
});
