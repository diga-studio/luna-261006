import { test } from "node:test";
import assert from "node:assert/strict";
import { planEvacuation } from "../src/index.js";
/** Apply a plan step by step, asserting every migration is legal at its moment. */
function assertExecutable(request, migrations) {
    const hostById = new Map(request.hosts.map((h) => [h.id, h]));
    const vmById = new Map(request.vms.map((v) => [v.id, v]));
    const placement = new Map(Object.entries(request.placement));
    const usedCpu = new Map(request.hosts.map((h) => [h.id, 0]));
    const usedMem = new Map(request.hosts.map((h) => [h.id, 0]));
    for (const [vmId, hostId] of placement) {
        const vm = vmById.get(vmId);
        usedCpu.set(hostId, usedCpu.get(hostId) + vm.cpu);
        usedMem.set(hostId, usedMem.get(hostId) + vm.memoryMib);
    }
    for (const step of migrations) {
        const vm = vmById.get(step.vmId);
        const target = hostById.get(step.toHostId);
        assert.equal(placement.get(step.vmId), step.fromHostId, "VM must be on the source host");
        assert.notEqual(step.toHostId, request.maintenanceHostId, "maintenance host accepts no migrations");
        assert.notEqual(step.fromHostId, step.toHostId);
        assert.equal(target.arch, vm.arch, "architecture must match");
        assert.ok(usedCpu.get(step.toHostId) + vm.cpu <= target.cpuBudget, "target CPU must fit before the move");
        assert.ok(usedMem.get(step.toHostId) + vm.memoryMib <= target.memoryBudgetMib, "target memory must fit before the move");
        // Source resources are released only after the migration completes.
        usedCpu.set(step.fromHostId, usedCpu.get(step.fromHostId) - vm.cpu);
        usedMem.set(step.fromHostId, usedMem.get(step.fromHostId) - vm.memoryMib);
        usedCpu.set(step.toHostId, usedCpu.get(step.toHostId) + vm.cpu);
        usedMem.set(step.toHostId, usedMem.get(step.toHostId) + vm.memoryMib);
        placement.set(step.vmId, step.toHostId);
    }
    for (const [, hostId] of placement) {
        assert.notEqual(hostId, request.maintenanceHostId, "maintenance host must end empty");
    }
    // Every VM still resides somewhere.
    assert.equal(placement.size, request.vms.length);
}
function planned(result) {
    assert.equal(result.status, "planned");
    return result.plan;
}
test("maintenance host already empty: optimal plan is empty", () => {
    const request = {
        hosts: [
            { id: "A", arch: "x86", cpuBudget: 8, memoryBudgetMib: 1024 },
            { id: "B", arch: "x86", cpuBudget: 8, memoryBudgetMib: 1024 },
        ],
        vms: [{ id: "v1", arch: "x86", cpu: 2, memoryMib: 128 }],
        placement: { v1: "B" },
        maintenanceHostId: "A",
    };
    const plan = planned(planEvacuation(request));
    assert.deepEqual(plan.migrations, []);
    assert.equal(plan.totalMigratedMemoryMib, 0);
});
test("simple direct evacuation in one migration", () => {
    const request = {
        hosts: [
            { id: "A", arch: "x86", cpuBudget: 8, memoryBudgetMib: 1024 },
            { id: "B", arch: "x86", cpuBudget: 8, memoryBudgetMib: 1024 },
        ],
        vms: [{ id: "x", arch: "x86", cpu: 4, memoryMib: 256 }],
        placement: { x: "A" },
        maintenanceHostId: "A",
    };
    const plan = planned(planEvacuation(request));
    assert.equal(plan.migrations.length, 1);
    assert.equal(plan.totalMigratedMemoryMib, 256);
    assertExecutable(request, plan.migrations);
});
test("must shuffle a VM on another host first; optimal count and memory verified", () => {
    // x (5 cpu) cannot fit directly on B (free 4) or C (free 4).
    // Only sequence: y -> C, then x -> B. 2 migrations, 20 + 50 = 70 MiB.
    const request = {
        hosts: [
            { id: "A", arch: "x86", cpuBudget: 10, memoryBudgetMib: 100 },
            { id: "B", arch: "x86", cpuBudget: 8, memoryBudgetMib: 64 },
            { id: "C", arch: "x86", cpuBudget: 10, memoryBudgetMib: 100 },
        ],
        vms: [
            { id: "x", arch: "x86", cpu: 5, memoryMib: 50 },
            { id: "y", arch: "x86", cpu: 4, memoryMib: 20 },
            { id: "z", arch: "x86", cpu: 6, memoryMib: 60 },
        ],
        placement: { x: "A", y: "B", z: "C" },
        maintenanceHostId: "A",
    };
    const plan = planned(planEvacuation(request));
    assert.equal(plan.migrations.length, 2);
    assert.equal(plan.totalMigratedMemoryMib, 70);
    assert.deepEqual(plan.migrations.map((m) => [m.vmId, m.fromHostId, m.toHostId]), [
        ["y", "B", "C"],
        ["x", "A", "B"],
    ]);
    assertExecutable(request, plan.migrations);
});
test("packable in theory but not migratable step by step: no-solution", () => {
    // Two receivers with 12 CPU each, used 7+3 and 5+5 (2 free each).
    // The 4-cpu VM fits nowhere, and no VM is small enough to move first.
    const request = {
        hosts: [
            { id: "A", arch: "x86", cpuBudget: 12, memoryBudgetMib: 4096 },
            { id: "B", arch: "x86", cpuBudget: 12, memoryBudgetMib: 4096 },
            { id: "C", arch: "x86", cpuBudget: 12, memoryBudgetMib: 4096 },
        ],
        vms: [
            { id: "x", arch: "x86", cpu: 4, memoryMib: 16 },
            { id: "b1", arch: "x86", cpu: 7, memoryMib: 16 },
            { id: "b2", arch: "x86", cpu: 3, memoryMib: 16 },
            { id: "c1", arch: "x86", cpu: 5, memoryMib: 16 },
            { id: "c2", arch: "x86", cpu: 5, memoryMib: 16 },
        ],
        placement: { x: "A", b1: "B", b2: "B", c1: "C", c2: "C" },
        maintenanceHostId: "A",
    };
    assert.equal(planEvacuation(request).status, "no-solution");
});
test("equal migration count: least total migrated memory wins", () => {
    // Two 2-move plans exist: move y (90 MiB) or move z (10 MiB) to unblock x.
    const request = {
        hosts: [
            { id: "A", arch: "x86", cpuBudget: 6, memoryBudgetMib: 100 },
            { id: "B", arch: "x86", cpuBudget: 6, memoryBudgetMib: 100 },
            { id: "C", arch: "x86", cpuBudget: 6, memoryBudgetMib: 100 },
        ],
        vms: [
            { id: "x", arch: "x86", cpu: 4, memoryMib: 50 },
            { id: "y", arch: "x86", cpu: 3, memoryMib: 90 },
            { id: "z", arch: "x86", cpu: 3, memoryMib: 10 },
        ],
        placement: { x: "A", y: "B", z: "C" },
        maintenanceHostId: "A",
    };
    const plan = planned(planEvacuation(request));
    assert.equal(plan.migrations.length, 2);
    assert.equal(plan.totalMigratedMemoryMib, 60);
    assertExecutable(request, plan.migrations);
});
test("architecture constraint: VM cannot move to a different-arch host", () => {
    const request = {
        hosts: [
            { id: "A", arch: "x86", cpuBudget: 8, memoryBudgetMib: 1024 },
            { id: "B", arch: "arm", cpuBudget: 64, memoryBudgetMib: 65536 },
        ],
        vms: [{ id: "x", arch: "x86", cpu: 2, memoryMib: 128 }],
        placement: { x: "A" },
        maintenanceHostId: "A",
    };
    assert.equal(planEvacuation(request).status, "no-solution");
});
test("chained shuffle: two non-maintenance VMs must move before x can land", () => {
    // x (5 cpu) fits nowhere directly. z must go to D before y can go to C,
    // and y must leave B before x can land there. Unique 3-move plan.
    const request = {
        hosts: [
            { id: "A", arch: "x86", cpuBudget: 8, memoryBudgetMib: 100 },
            { id: "B", arch: "x86", cpuBudget: 6, memoryBudgetMib: 100 },
            { id: "C", arch: "x86", cpuBudget: 4, memoryBudgetMib: 100 },
            { id: "D", arch: "x86", cpuBudget: 3, memoryBudgetMib: 100 },
        ],
        vms: [
            { id: "x", arch: "x86", cpu: 5, memoryMib: 50 },
            { id: "y", arch: "x86", cpu: 4, memoryMib: 20 },
            { id: "z", arch: "x86", cpu: 3, memoryMib: 20 },
        ],
        placement: { x: "A", y: "B", z: "C" },
        maintenanceHostId: "A",
    };
    const plan = planned(planEvacuation(request));
    assert.equal(plan.migrations.length, 3);
    assert.equal(plan.totalMigratedMemoryMib, 90);
    assert.deepEqual(plan.migrations.map((m) => [m.vmId, m.fromHostId, m.toHostId]), [
        ["z", "C", "D"],
        ["y", "B", "C"],
        ["x", "A", "B"],
    ]);
    assertExecutable(request, plan.migrations);
});
test("input is not mutated by planning", () => {
    const request = {
        hosts: [
            { id: "A", arch: "x86", cpuBudget: 8, memoryBudgetMib: 100 },
            { id: "B", arch: "x86", cpuBudget: 8, memoryBudgetMib: 100 },
        ],
        vms: [{ id: "x", arch: "x86", cpu: 2, memoryMib: 10 }],
        placement: { x: "A" },
        maintenanceHostId: "A",
    };
    const snapshot = JSON.stringify(request);
    planEvacuation(request);
    assert.equal(JSON.stringify(request), snapshot);
});
