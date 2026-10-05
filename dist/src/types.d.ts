/** CPU architecture of a host or VM. */
export type Architecture = "x86" | "arm";
/** A physical host in the cluster. */
export interface Host {
    /** Unique host identifier. */
    id: string;
    arch: Architecture;
    /** Total approved vCPU budget. */
    cpuBudget: number;
    /** Total approved memory budget in MiB. */
    memoryBudgetMib: number;
}
/** A virtual machine with fixed resource demands. */
export interface Vm {
    /** Unique VM identifier. */
    id: string;
    arch: Architecture;
    /** Required vCPUs. */
    cpu: number;
    /** Required memory in MiB. */
    memoryMib: number;
}
/** Planning input: cluster, current placement, and the host to evacuate. */
export interface EvacuationRequest {
    hosts: Host[];
    vms: Vm[];
    /** Current placement: vmId -> hostId. Guaranteed legal. */
    placement: Readonly<Record<string, string>>;
    /** The single host under maintenance; must be fully evacuated. */
    maintenanceHostId: string;
}
/** One ordered migration step. */
export interface Migration {
    vmId: string;
    fromHostId: string;
    toHostId: string;
}
/** A complete executable plan. */
export interface EvacuationPlan {
    migrations: Migration[];
    /** Sum of memoryMib over all migrations (a VM migrated k times counts k times). */
    totalMigratedMemoryMib: number;
}
/** Planning result: either an optimal plan, or a definitive "no plan exists". */
export type EvacuationResult = {
    status: "planned";
    plan: EvacuationPlan;
} | {
    status: "no-solution";
};
