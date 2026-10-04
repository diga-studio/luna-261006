import { test } from "node:test";
import assert from "node:assert/strict";
import { WildPineScheduler, type ReviewedOrder } from "../src/index.js";

test("a wholly skipped local date produces no doses", () => {
  const scheduler = new WildPineScheduler();
  const order: ReviewedOrder = {
    orderId: "order-apia",
    camperId: "camper-4",
    session: {
      timeZone: "Pacific/Apia",
      startDate: "2011-12-29",
      endDate: "2012-01-02",
    },
    versions: [
      {
        versionId: "v1",
        times: ["08:00"],
        validFromUtc: "2011-12-01T00:00:00.000Z",
        validToUtc: "2012-02-01T00:00:00.000Z",
      },
    ],
  };
  scheduler.loadOrder(order);
  const doses = scheduler.queryDoses(
    "2011-12-01T00:00:00.000Z",
    "2012-02-01T00:00:00.000Z",
    "2012-01-01T00:00:00.000Z",
  );
  assert.deepEqual(
    doses.map((d) => [d.localDate, d.scheduledUtc]),
    [
      ["2011-12-29", "2011-12-29T18:00:00.000Z"],
      ["2011-12-31", "2011-12-30T18:00:00.000Z"],
      ["2012-01-01", "2011-12-31T18:00:00.000Z"],
    ],
  );
  scheduler.close();
});

test("30-minute gap shifts doses by 30 minutes, not to the gap end", () => {
  const scheduler = new WildPineScheduler();
  const order: ReviewedOrder = {
    orderId: "order-lord-howe",
    camperId: "camper-5",
    session: {
      timeZone: "Australia/Lord_Howe",
      startDate: "2025-10-05",
      endDate: "2025-10-06",
    },
    versions: [
      {
        versionId: "v1",
        times: ["02:15"],
        validFromUtc: "2025-10-01T00:00:00.000Z",
        validToUtc: "2025-11-01T00:00:00.000Z",
      },
    ],
  };
  scheduler.loadOrder(order);
  const doses = scheduler.queryDoses(
    "2025-10-01T00:00:00.000Z",
    "2025-11-01T00:00:00.000Z",
    "2025-10-04T16:00:00.000Z",
  );
  assert.equal(doses.length, 1);
  // 02:15 falls in the 02:00-02:30 gap; shifted by the 30-minute offset
  // change to 02:45 local = 15:45Z, not to 02:30 local = 15:30Z.
  assert.equal(doses[0]!.scheduledUtc, "2025-10-04T15:45:00.000Z");
  scheduler.close();
});

test("doses outside the session dates are not produced even inside version validity", () => {
  const scheduler = new WildPineScheduler();
  const order: ReviewedOrder = {
    orderId: "order-window",
    camperId: "camper-6",
    session: {
      timeZone: "Asia/Shanghai",
      startDate: "2025-06-10",
      endDate: "2025-06-12",
    },
    versions: [
      {
        versionId: "v1",
        times: ["08:00"],
        validFromUtc: "2025-06-01T00:00:00.000Z",
        validToUtc: "2025-07-01T00:00:00.000Z",
      },
    ],
  };
  scheduler.loadOrder(order);
  const doses = scheduler.queryDoses(
    "2025-06-01T00:00:00.000Z",
    "2025-07-01T00:00:00.000Z",
    "2025-07-01T00:00:00.000Z",
  );
  assert.deepEqual(
    doses.map((d) => d.localDate),
    ["2025-06-10", "2025-06-11"],
  );
  scheduler.close();
});

test("planned instant outside the version validity range yields no dose", () => {
  const scheduler = new WildPineScheduler();
  const order: ReviewedOrder = {
    orderId: "order-gap-version",
    camperId: "camper-7",
    session: {
      timeZone: "Asia/Shanghai",
      startDate: "2025-06-10",
      endDate: "2025-06-13",
    },
    versions: [
      {
        versionId: "v1",
        times: ["08:00"],
        // 06-11 08:00 CST = 06-11 00:00Z falls in the gap between versions.
        validFromUtc: "2025-06-10T00:00:00.000Z",
        validToUtc: "2025-06-11T00:00:00.000Z",
      },
      {
        versionId: "v2",
        times: ["08:00"],
        validFromUtc: "2025-06-12T00:00:00.000Z",
        validToUtc: "2025-06-13T00:00:00.000Z",
      },
    ],
  };
  scheduler.loadOrder(order);
  const doses = scheduler.queryDoses(
    "2025-06-01T00:00:00.000Z",
    "2025-07-01T00:00:00.000Z",
    "2025-07-01T00:00:00.000Z",
  );
  assert.deepEqual(
    doses.map((d) => [d.localDate, d.versionId]),
    [
      ["2025-06-10", "v1"],
      ["2025-06-12", "v2"],
    ],
  );
  scheduler.close();
});
