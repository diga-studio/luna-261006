import { test } from "node:test";
import assert from "node:assert/strict";
import { rebalance } from "../src/rebalance";
import { RebalanceResult } from "../src/types";

function bindingOf(result: RebalanceResult, deviceId: string): string | undefined {
  return result.assignments.find((a) => a.deviceId === deviceId)?.poolId;
}

test("empty input yields empty result", () => {
  const result = rebalance({ businessDate: "2026-01-01", devices: [], pools: [] });
  assert.deepEqual(result, { assignments: [], uncoveredDeviceIds: [] });
});

test("migrates device across pools to avoid a false gap", () => {
  // Pool P1 covers departments 甲 and 乙, pool P2 covers only 甲; 1 seat each.
  // 甲 device previously held P1; when a 乙 device joins, the 甲 device must
  // move to P2 so both are covered — 乙 must not be reported as a gap.
  const result = rebalance({
    businessDate: "2026-06-01",
    devices: [
      { id: "dev-jia", department: "甲", previousPoolId: "P1" },
      { id: "dev-yi", department: "乙" },
    ],
    pools: [
      { id: "P1", totalSeats: 1, expiresAt: "2026-12-31", allowedDepartments: ["甲", "乙"] },
      { id: "P2", totalSeats: 1, expiresAt: "2026-12-31", allowedDepartments: ["甲"] },
    ],
  });

  assert.deepEqual(result.uncoveredDeviceIds, []);
  assert.equal(result.assignments.length, 2);
  assert.equal(bindingOf(result, "dev-jia"), "P2");
  assert.equal(bindingOf(result, "dev-yi"), "P1");
});

test("keeps previous bindings when nothing forces a change", () => {
  const result = rebalance({
    businessDate: "2026-06-01",
    devices: [
      { id: "d1", department: "甲", previousPoolId: "P1" },
      { id: "d2", department: "甲", previousPoolId: "P2" },
    ],
    pools: [
      { id: "P1", totalSeats: 1, expiresAt: "2026-12-31", allowedDepartments: ["甲"] },
      { id: "P2", totalSeats: 1, expiresAt: "2026-12-31", allowedDepartments: ["甲"] },
    ],
  });

  assert.deepEqual(result.uncoveredDeviceIds, []);
  assert.equal(bindingOf(result, "d1"), "P1");
  assert.equal(bindingOf(result, "d2"), "P2");
});

test("prefers the previously bound device when seats run short", () => {
  const result = rebalance({
    businessDate: "2026-06-01",
    devices: [
      { id: "d-old", department: "甲", previousPoolId: "P1" },
      { id: "d-new", department: "甲" },
    ],
    pools: [{ id: "P1", totalSeats: 1, expiresAt: "2026-12-31", allowedDepartments: ["甲"] }],
  });

  assert.equal(result.assignments.length, 1);
  assert.equal(bindingOf(result, "d-old"), "P1");
  assert.deepEqual(result.uncoveredDeviceIds, ["d-new"]);
});

test("returns best partial coverage instead of failing when seats are insufficient", () => {
  const result = rebalance({
    businessDate: "2026-06-01",
    devices: [
      { id: "d1", department: "甲" },
      { id: "d2", department: "甲" },
      { id: "d3", department: "乙" },
    ],
    pools: [{ id: "P1", totalSeats: 2, expiresAt: "2026-12-31", allowedDepartments: ["甲", "乙"] }],
  });

  assert.equal(result.assignments.length, 2);
  assert.equal(result.uncoveredDeviceIds.length, 1);
});

test("pool is valid on its expiry day but not before the business date", () => {
  const pools = [{ id: "P1", totalSeats: 1, expiresAt: "2026-06-01", allowedDepartments: ["甲"] }];
  const devices = [{ id: "d1", department: "甲" as string }];

  const onExpiryDay = rebalance({ businessDate: "2026-06-01", devices, pools });
  assert.equal(bindingOf(onExpiryDay, "d1"), "P1");
  assert.deepEqual(onExpiryDay.uncoveredDeviceIds, []);

  const afterExpiry = rebalance({ businessDate: "2026-06-02", devices, pools });
  assert.equal(afterExpiry.assignments.length, 0);
  assert.deepEqual(afterExpiry.uncoveredDeviceIds, ["d1"]);
});

test("rebinds when the previous pool expired", () => {
  const result = rebalance({
    businessDate: "2026-06-01",
    devices: [{ id: "d1", department: "甲", previousPoolId: "P-old" }],
    pools: [
      { id: "P-old", totalSeats: 1, expiresAt: "2026-01-01", allowedDepartments: ["甲"] },
      { id: "P-new", totalSeats: 1, expiresAt: "2026-12-31", allowedDepartments: ["甲"] },
    ],
  });

  assert.equal(bindingOf(result, "d1"), "P-new");
  assert.deepEqual(result.uncoveredDeviceIds, []);
});

test("respects department scope of each pool", () => {
  const result = rebalance({
    businessDate: "2026-06-01",
    devices: [{ id: "d1", department: "丙", previousPoolId: "P1" }],
    pools: [{ id: "P1", totalSeats: 1, expiresAt: "2026-12-31", allowedDepartments: ["甲"] }],
  });

  assert.equal(result.assignments.length, 0);
  assert.deepEqual(result.uncoveredDeviceIds, ["d1"]);
});

test("seat shrink forces partial coverage while preserving remaining bindings", () => {
  const result = rebalance({
    businessDate: "2026-06-01",
    devices: [
      { id: "d1", department: "甲", previousPoolId: "P1" },
      { id: "d2", department: "甲", previousPoolId: "P1" },
    ],
    pools: [{ id: "P1", totalSeats: 1, expiresAt: "2026-12-31", allowedDepartments: ["甲"] }],
  });

  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].poolId, "P1");
  assert.equal(result.uncoveredDeviceIds.length, 1);
});
