import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WildPineScheduler, type ReviewedOrder } from "../src/index.js";

const order: ReviewedOrder = {
  orderId: "order-persist",
  camperId: "camper-3",
  session: {
    timeZone: "America/New_York",
    startDate: "2025-03-08",
    endDate: "2025-03-11",
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

test("dose identity and administrations survive closing and reopening the database", () => {
  const file = join(mkdtempSync(join(tmpdir(), "wildpine-")), "meds.sqlite");
  const observe = "2025-03-09T08:00:00.000Z";
  const from = "2025-03-08T00:00:00.000Z";
  const to = "2025-03-11T00:00:00.000Z";

  const first = new WildPineScheduler({ filename: file });
  first.loadOrder(order);
  const before = first.queryDoses(from, to, observe);
  const target = before.find(
    (d) => d.localDate === "2025-03-09" && d.localTime === "02:30",
  )!;
  const { scheduledUtc, status, administeredUtc, ...identity } = target;
  first.recordAdministration(identity, "2025-03-09T07:35:00.000Z");
  const beforeClose = first.queryDoses(from, to, observe);
  first.close();

  const second = new WildPineScheduler({ filename: file });
  const afterReopen = second.queryDoses(from, to, observe);
  assert.deepEqual(afterReopen, beforeClose);
  const reopened = afterReopen.find(
    (d) => d.localDate === "2025-03-09" && d.localTime === "02:30",
  )!;
  assert.equal(reopened.status, "administered");
  assert.equal(reopened.administeredUtc, "2025-03-09T07:35:00.000Z");
  // Reloading the same persisted order is still rejected.
  assert.throws(() => second.loadOrder(order), /already loaded/);
  second.close();
});
