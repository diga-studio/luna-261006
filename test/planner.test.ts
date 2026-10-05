import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planEvacuation,
  type ClusterInput,
  type EvacuationPlan,
} from "../src/index.js";

/** Simulate a plan step by step, asserting every migration is legal. */
function assertExecutable(input: ClusterInput, plan: EvacuationPlan): void {
  const hostById = new Map(input.hosts.map((h) => [h.id, h]));
  const vmById = new Map(input.vms.map((v) => [v.id, v]));
  const placement = new Map(Object.entries(input.placement));
  const cpuUsed = new Map(input.hosts.map((h) => [h.id, 0]));
  const memUsed = new Map(input.hosts.map((h) => [h.id, 0]));
  for (const [vmId, hostId] of placement) {
    const vm = vmById.get(vmId)!;
    cpuUsed.set(hostId, cpuUsed.get(hostId)! + vm.cpu);
    memUsed.set(hostId, memUsed.get(hostId)! + vm.mem);
  }

  for (const step of plan.migrations) {
    const vm = vmById.get(step.vmId)!;
    const target = hostById.get(step.toHostId)!;
    assert.equal(placement.get(step.vmId), step.fromHostId, "vm must be on the source host");
    assert.notEqual(step.toHostId, input.maintenanceHostId, "maintenance host accepts no inbound migrations");
    assert.equal(target.arch, vm.arch, "architecture must match");
    assert.ok(cpuUsed.get(step.toHostId)! + vm.cpu <= target.cpuBudget, "target cpu budget exceeded");
    assert.ok(memUsed.get(step.toHostId)! + vm.mem <= target.memBudget, "target mem budget exceeded");
    cpuUsed.set(step.fromHostId, cpuUsed.get(step.fromHostId)! - vm.cpu);
    memUsed.set(step.fromHostId, memUsed.get(step.fromHostId)! - vm.mem);
    cpuUsed.set(step.toHostId, cpuUsed.get(step.toHostId)! + vm.cpu);
    memUsed.set(step.toHostId, memUsed.get(step.toHostId)! + vm.mem);
    placement.set(step.vmId, step.toHostId);
  }

  for (const [, hostId] of placement) {
    assert.notEqual(hostId, input.maintenanceHostId, "maintenance host must be empty at the end");
  }
  assert.equal(plan.migrationCount, plan.migrations.length);
  const expectedMem = plan.migrations.reduce((sum, m) => sum + vmById.get(m.vmId)!.mem, 0);
  assert.equal(plan.totalMigratedMem, expectedMem);
}

test("empty maintenance host needs no migrations", () => {
  const input: ClusterInput = {
    hosts: [
      { id: "M", arch: "x86", cpuBudget: 8, memBudget: 1024 },
      { id: "A", arch: "x86", cpuBudget: 8, memBudget: 1024 },
    ],
    vms: [{ id: "a", arch: "x86", cpu: 2, mem: 128 }],
    placement: { a: "A" },
    maintenanceHostId: "M",
  };
  const result = planEvacuation(input);
  assert.ok(result.ok);
  assert.equal(result.plan.migrationCount, 0);
  assert.equal(result.plan.totalMigratedMem, 0);
  assert.deepEqual(result.plan.migrations, []);
});

test("must relocate a VM on another host first; optimal count and memory", () => {
  // a (4 cpu) sits on M. A has 3 free cpu, B has 3 free cpu: a fits nowhere
  // directly. Moving b (3 cpu) from A to B frees A for a. Optimal: 2 moves.
  const input: ClusterInput = {
    hosts: [
      { id: "M", arch: "x86", cpuBudget: 8, memBudget: 1024 },
      { id: "A", arch: "x86", cpuBudget: 6, memBudget: 1024 },
      { id: "B", arch: "x86", cpuBudget: 3, memBudget: 1024 },
    ],
    vms: [
      { id: "a", arch: "x86", cpu: 4, mem: 100 },
      { id: "b", arch: "x86", cpu: 3, mem: 50 },
    ],
    placement: { a: "M", b: "A" },
    maintenanceHostId: "M",
  };
  const result = planEvacuation(input);
  assert.ok(result.ok);
  assert.equal(result.plan.migrationCount, 2);
  assert.equal(result.plan.totalMigratedMem, 150);
  assertExecutable(input, result.plan);
  assert.deepEqual(
    result.plan.migrations.map((m) => [m.vmId, m.fromHostId, m.toHostId]),
    [
      ["b", "A", "B"],
      ["a", "M", "A"],
    ],
  );
});

test("packing exists but no live migration sequence: proven no-solution", () => {
  // Two receiver hosts with 12 cpu each: A holds 7+3, B holds 5+5 (2 free
  // each). The 4-cpu VM on M fits nowhere, and no VM on A or B can move to
  // the other host (needs >= 3 free, only 2 available). Deadlock.
  const input: ClusterInput = {
    hosts: [
      { id: "M", arch: "x86", cpuBudget: 12, memBudget: 4096 },
      { id: "A", arch: "x86", cpuBudget: 12, memBudget: 4096 },
      { id: "B", arch: "x86", cpuBudget: 12, memBudget: 4096 },
    ],
    vms: [
      { id: "x", arch: "x86", cpu: 4, mem: 64 },
      { id: "a1", arch: "x86", cpu: 7, mem: 64 },
      { id: "a2", arch: "x86", cpu: 3, mem: 64 },
      { id: "b1", arch: "x86", cpu: 5, mem: 64 },
      { id: "b2", arch: "x86", cpu: 5, mem: 64 },
    ],
    placement: { x: "M", a1: "A", a2: "A", b1: "B", b2: "B" },
    maintenanceHostId: "M",
  };
  const result = planEvacuation(input);
  assert.equal(result.ok, false);
});

test("architecture mismatch leaves no target: no solution", () => {
  const input: ClusterInput = {
    hosts: [
      { id: "M", arch: "arm", cpuBudget: 8, memBudget: 1024 },
      { id: "A", arch: "x86", cpuBudget: 8, memBudget: 1024 },
    ],
    vms: [{ id: "a", arch: "arm", cpu: 2, mem: 128 }],
    placement: { a: "M" },
    maintenanceHostId: "M",
  };
  const result = planEvacuation(input);
  assert.equal(result.ok, false);
});

test("prefers fewer migrations, then less migrated memory", () => {
  // a (2 cpu, 300 MiB) on M. Direct move to C costs 1 move / 300 MiB.
  // Detour via B would be 2 moves. Direct must win.
  const input: ClusterInput = {
    hosts: [
      { id: "M", arch: "x86", cpuBudget: 8, memBudget: 1024 },
      { id: "B", arch: "x86", cpuBudget: 8, memBudget: 1024 },
      { id: "C", arch: "x86", cpuBudget: 8, memBudget: 1024 },
    ],
    vms: [{ id: "a", arch: "x86", cpu: 2, mem: 300 }],
    placement: { a: "M" },
    maintenanceHostId: "M",
  };
  const result = planEvacuation(input);
  assert.ok(result.ok);
  assert.equal(result.plan.migrationCount, 1);
  assert.equal(result.plan.totalMigratedMem, 300);
  assertExecutable(input, result.plan);
});

test("memory budget can force a shuffle even when cpu is ample", () => {
  // a (200 MiB) on M. A has only 150 MiB free because of c (150 MiB);
  // B can hold c (150 MiB budget) but not a. Plan: c A->B, then a M->A.
  const input: ClusterInput = {
    hosts: [
      { id: "M", arch: "x86", cpuBudget: 8, memBudget: 512 },
      { id: "A", arch: "x86", cpuBudget: 8, memBudget: 300 },
      { id: "B", arch: "x86", cpuBudget: 8, memBudget: 150 },
    ],
    vms: [
      { id: "a", arch: "x86", cpu: 4, mem: 200 },
      { id: "c", arch: "x86", cpu: 1, mem: 150 },
    ],
    placement: { a: "M", c: "A" },
    maintenanceHostId: "M",
  };
  const result = planEvacuation(input);
  assert.ok(result.ok);
  assert.equal(result.plan.migrationCount, 2);
  assert.equal(result.plan.totalMigratedMem, 350);
  assertExecutable(input, result.plan);
});
