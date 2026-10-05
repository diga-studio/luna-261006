/** CPU architecture of a host or VM. */
export type Architecture = "x86" | "arm";

/** A host in the cluster. Budgets are pre-approved by the caller. */
export interface Host {
  /** Unique host identifier. */
  readonly id: string;
  readonly arch: Architecture;
  /** Total vCPU budget. */
  readonly cpuBudget: number;
  /** Total memory budget in MiB. */
  readonly memBudget: number;
}

/** A virtual machine with fixed resource demands. */
export interface Vm {
  /** Unique VM identifier. */
  readonly id: string;
  readonly arch: Architecture;
  readonly cpu: number;
  /** Memory demand in MiB. */
  readonly mem: number;
}

/** One ordered migration step. */
export interface Migration {
  readonly vmId: string;
  readonly fromHostId: string;
  readonly toHostId: string;
}

/** A complete executable evacuation plan. */
export interface EvacuationPlan {
  /** Ordered migrations; executing them in order evacuates the maintenance host. */
  readonly migrations: readonly Migration[];
  /** Number of migrations (== migrations.length). */
  readonly migrationCount: number;
  /** Sum of memory (MiB) of every migrated VM, counted per migration. */
  readonly totalMigratedMem: number;
}

/** Result of planning: either an optimal plan, or a proven no-solution. */
export type PlanResult =
  | { readonly ok: true; readonly plan: EvacuationPlan }
  | { readonly ok: false; readonly reason: string };

/** Cluster input for the planner. Treated as immutable. */
export interface ClusterInput {
  readonly hosts: readonly Host[];
  readonly vms: readonly Vm[];
  /** Current placement: vmId -> hostId. Must be a legal allocation. */
  readonly placement: Readonly<Record<string, string>>;
  /** The unique host to evacuate. Accepts no inbound migrations. */
  readonly maintenanceHostId: string;
}
