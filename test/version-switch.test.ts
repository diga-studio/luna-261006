import { test } from "node:test";
import assert from "node:assert/strict";
import { WildPineScheduler, type ReviewedOrder, type ScheduledDose } from "../src/index.js";

// America/New_York falls back on 2025-11-02: 01:30 happens twice, at
// 05:30Z (EDT) and 06:30Z (EST). The version switches at 06:00Z, inside
// the repeated hour.
function fallBackOrder(): ReviewedOrder {
  return {
    orderId: "order-fallback",
    camperId: "camper-2",
    session: {
      timeZone: "America/New_York",
      startDate: "2025-11-01",
      endDate: "2025-11-04",
    },
    versions: [
      {
        versionId: "v-old",
        times: ["01:30"],
        validFromUtc: "2025-11-01T00:00:00.000Z",
        validToUtc: "2025-11-02T06:00:00.000Z",
      },
      {
        versionId: "v-new",
        times: ["01:30"],
        validFromUtc: "2025-11-02T06:00:00.000Z",
        validToUtc: "2025-11-04T00:00:00.000Z",
      },
    ],
  };
}

function simplify(doses: ScheduledDose[]) {
  return doses.map((d) => ({
    orderId: d.orderId,
    versionId: d.versionId,
    localDate: d.localDate,
    localTime: d.localTime,
    scheduledUtc: d.scheduledUtc,
    administeredUtc: d.administeredUtc,
    status: d.status,
  }));
}

test("version switch inside a repeated hour: new version cannot borrow the second occurrence", () => {
  const scheduler = new WildPineScheduler();
  scheduler.loadOrder(fallBackOrder());

  const doses = scheduler.queryDoses(
    "2025-11-01T00:00:00.000Z",
    "2025-11-04T00:00:00.000Z",
    "2025-11-04T00:00:00.000Z",
  );
  // 11-01 01:30 EDT -> 05:30Z (v-old); 11-02 01:30 -> earlier occurrence
  // 05:30Z (v-old, still valid); 11-03 01:30 EST -> 06:30Z (v-new).
  assert.deepEqual(simplify(doses), [
    {
      orderId: "order-fallback",
      versionId: "v-old",
      localDate: "2025-11-01",
      localTime: "01:30",
      scheduledUtc: "2025-11-01T05:30:00.000Z",
      administeredUtc: null,
      status: "overdue",
    },
    {
      orderId: "order-fallback",
      versionId: "v-old",
      localDate: "2025-11-02",
      localTime: "01:30",
      scheduledUtc: "2025-11-02T05:30:00.000Z",
      administeredUtc: null,
      status: "overdue",
    },
    {
      orderId: "order-fallback",
      versionId: "v-new",
      localDate: "2025-11-03",
      localTime: "01:30",
      scheduledUtc: "2025-11-03T06:30:00.000Z",
      administeredUtc: null,
      status: "overdue",
    },
  ]);

  // The new version owns no dose on 11-02: the second occurrence of 01:30
  // (06:30Z) must not be used to fill one in.
  const newVersionWindow = scheduler.queryDoses(
    "2025-11-02T06:00:00.000Z",
    "2025-11-03T00:00:00.000Z",
    "2025-11-04T00:00:00.000Z",
  );
  assert.deepEqual(newVersionWindow, []);
  scheduler.close();
});

test("splitting the query range never changes the merged result", () => {
  const observe = "2025-11-02T06:15:00.000Z";
  const from = "2025-11-02T00:00:00.000Z";
  const to = "2025-11-02T12:00:00.000Z";
  // Split points inside the repeated hour and exactly on the dose instant.
  const splitPoints = [
    "2025-11-02T05:30:00.000Z",
    "2025-11-02T05:45:00.000Z",
    "2025-11-02T06:00:00.000Z",
    "2025-11-02T06:30:00.000Z",
  ];

  const makeScheduler = () => {
    const scheduler = new WildPineScheduler();
    scheduler.loadOrder(fallBackOrder());
    const [dose] = scheduler.queryDoses(from, to, observe);
    const { scheduledUtc, status, administeredUtc, ...identity } = dose!;
    scheduler.recordAdministration(identity, "2025-11-02T05:40:00.000Z");
    return scheduler;
  };

  const full = simplify(makeScheduler().queryDoses(from, to, observe));
  assert.equal(full.length, 1);
  assert.equal(full[0]!.status, "administered");

  for (const split of splitPoints) {
    const scheduler = makeScheduler();
    const left = scheduler.queryDoses(from, split, observe);
    const right = scheduler.queryDoses(split, to, observe);
    assert.deepEqual(simplify([...left, ...right]), full, `split at ${split}`);
    scheduler.close();
  }
});
