import { test } from "node:test";
import { ok, equal, deepEqual } from "node:assert/strict";
import { BomService } from "../src/bomService";
import { verifyWitness, bomAtFromRevisions, NaiveBom } from "./helpers/naive";
import { BomRevision } from "../src/types";

test("time-separated mutual references are accepted", () => {
  const service = new BomService();
  const r1 = service.publishBatch([
    { assemblyId: "A", startDay: 10, components: ["B"] },
    { assemblyId: "A", startDay: 20, components: [] },
  ]);
  ok(r1.ok, "A->B on [10,20) then empty must be accepted");

  const r2 = service.publishBatch([{ assemblyId: "B", startDay: 20, components: ["A"] }]);
  ok(r2.ok, "B->A starting exactly when A empties must be accepted");

  deepEqual(service.bomAt("A", 0), null);
  deepEqual(service.bomAt("A", 10), { assemblyId: "A", startDay: 10, components: ["B"] });
  deepEqual(service.bomAt("A", 19), { assemblyId: "A", startDay: 10, components: ["B"] });
  deepEqual(service.bomAt("A", 20), { assemblyId: "A", startDay: 20, components: [] });
  deepEqual(service.bomAt("B", 20), { assemblyId: "B", startDay: 20, components: ["A"] });
  deepEqual(service.bomAt("B", 1_000_000_000), { assemblyId: "B", startDay: 20, components: ["A"] });
});

test("persistent overlapping mutual reference is rejected with a real witness", () => {
  const prior: BomRevision[] = [{ assemblyId: "B", startDay: 30, components: ["A"] }];
  const batch: BomRevision[] = [{ assemblyId: "A", startDay: 10, components: ["B"] }];

  const service = new BomService();
  ok(service.publishBatch(prior).ok);
  const result = service.publishBatch(batch);

  ok(!result.ok, "A->B from day 10 forever plus B->A from day 30 must be rejected");
  if (result.ok) return;

  ok(result.witness.day >= 30, "cycle can only close once B->A is effective");
  ok(
    verifyWitness(bomAtFromRevisions(prior.concat(batch)), result.witness),
    "witness path must actually close on the reported day in the final timetable",
  );
  deepEqual(result.witness.path[0], result.witness.path[result.witness.path.length - 1]);

  deepEqual(service.bomAt("A", 15), null, "rejected batch leaves no trace");
  deepEqual(service.bomAt("B", 30), { assemblyId: "B", startDay: 30, components: ["A"] });
});

test("rejection witness agrees with the naive reference", () => {
  const prior: BomRevision[] = [{ assemblyId: "B", startDay: 30, components: ["A"] }];
  const batch: BomRevision[] = [{ assemblyId: "A", startDay: 10, components: ["B"] }];

  const service = new BomService();
  const naive = new NaiveBom();
  ok(service.publishBatch(prior).ok);
  ok(naive.publishBatch(prior).ok);

  const fast = service.publishBatch(batch);
  const slow = naive.publishBatch(batch);
  ok(!fast.ok && !slow.ok, "both implementations must reject");
  if (!fast.ok && !slow.ok) {
    equal(fast.witness.day >= 30, true);
    equal(slow.witness.day >= 30, true);
  }
});
