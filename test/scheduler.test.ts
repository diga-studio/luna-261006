import { test } from "node:test";
import assert from "node:assert/strict";
import { WildPineScheduler, type ReviewedOrder, type ScheduledDose } from "../src/index.js";

function springForwardOrder(): ReviewedOrder {
  return {
    orderId: "order-spring",
    camperId: "camper-1",
    session: {
      timeZone: "America/New_York",
      startDate: "2025-03-01",
      endDate: "2025-04-01",
    },
    versions: [
      {
        versionId: "v1",
        times: ["02:30", "03:30"],
        validFromUtc: "2025-03-01T00:00:00.000Z",
        validToUtc: "2025-04-01T00:00:00.000Z",
      },
    ],
  };
}

function doseAt(doses: ScheduledDose[], localTime: string): ScheduledDose {
  const dose = doses.find((d) => d.localDate === "2025-03-09" && d.localTime === localTime);
  assert.ok(dose, `expected a dose at ${localTime}`);
  return dose;
}

test("spring forward: 02:30 and 03:30 both map to 07:30Z but stay two doses", () => {
  const scheduler = new WildPineScheduler();
  scheduler.loadOrder(springForwardOrder());

  const doses = scheduler.queryDoses(
    "2025-03-09T00:00:00.000Z",
    "2025-03-10T00:00:00.000Z",
    "2025-03-09T07:44:59.999Z",
  );
  assert.equal(doses.length, 2);
  assert.equal(doseAt(doses, "02:30").scheduledUtc, "2025-03-09T07:30:00.000Z");
  assert.equal(doseAt(doses, "03:30").scheduledUtc, "2025-03-09T07:30:00.000Z");
  // Distinct identities despite the identical planned UTC instant.
  assert.notDeepEqual(
    { ...doseAt(doses, "02:30"), scheduledUtc: null, status: null, administeredUtc: null },
    { ...doseAt(doses, "03:30"), scheduledUtc: null, status: null, administeredUtc: null },
  );
  // 14:59.999 after 07:30: not yet overdue.
  assert.equal(doseAt(doses, "02:30").status, "pending");
  assert.equal(doseAt(doses, "03:30").status, "pending");

  // Record only the 02:30 dose.
  const { scheduledUtc, status, administeredUtc, ...identity } = doseAt(doses, "02:30");
  scheduler.recordAdministration(identity, "2025-03-09T07:35:00.000Z");

  // Exactly 15 minutes after the planned time: the other dose is overdue.
  const after = scheduler.queryDoses(
    "2025-03-09T00:00:00.000Z",
    "2025-03-10T00:00:00.000Z",
    "2025-03-09T07:45:00.000Z",
  );
  assert.equal(after.length, 2);
  const recorded = doseAt(after, "02:30");
  assert.equal(recorded.status, "administered");
  assert.equal(recorded.administeredUtc, "2025-03-09T07:35:00.000Z");
  const other = doseAt(after, "03:30");
  assert.equal(other.status, "overdue");
  assert.equal(other.administeredUtc, null);
  scheduler.close();
});

test("duplicate registration is rejected and never overwrites", () => {
  const scheduler = new WildPineScheduler();
  scheduler.loadOrder(springForwardOrder());
  const [dose] = scheduler.queryDoses(
    "2025-03-09T00:00:00.000Z",
    "2025-03-10T00:00:00.000Z",
    "2025-03-09T08:00:00.000Z",
  );
  const { scheduledUtc, status, administeredUtc, ...identity } = dose!;
  scheduler.recordAdministration(identity, "2025-03-09T07:35:00.000Z");
  assert.throws(
    () => scheduler.recordAdministration(identity, "2025-03-09T09:00:00.000Z"),
    /already administered/,
  );
  const [again] = scheduler.queryDoses(
    "2025-03-09T00:00:00.000Z",
    "2025-03-10T00:00:00.000Z",
    "2025-03-09T10:00:00.000Z",
  );
  assert.equal(again!.administeredUtc, "2025-03-09T07:35:00.000Z");
  scheduler.close();
});

test("loading the same order id twice is rejected", () => {
  const scheduler = new WildPineScheduler();
  scheduler.loadOrder(springForwardOrder());
  assert.throws(() => scheduler.loadOrder(springForwardOrder()), /already loaded/);
  scheduler.close();
});

test("administration recorded after the observation instant is not yet administered", () => {
  const scheduler = new WildPineScheduler();
  scheduler.loadOrder(springForwardOrder());
  const doses = scheduler.queryDoses(
    "2025-03-09T00:00:00.000Z",
    "2025-03-10T00:00:00.000Z",
    "2025-03-09T06:00:00.000Z",
  );
  const { scheduledUtc, status, administeredUtc, ...identity } = doseAt(doses, "02:30");
  scheduler.recordAdministration(identity, "2025-03-09T08:00:00.000Z");
  const observed = scheduler.queryDoses(
    "2025-03-09T00:00:00.000Z",
    "2025-03-10T00:00:00.000Z",
    "2025-03-09T07:45:00.000Z",
  );
  // Administration at 08:00Z is later than the 07:45Z observation: overdue, not administered.
  assert.equal(doseAt(observed, "02:30").status, "overdue");
  scheduler.close();
});
