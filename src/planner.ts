import type { ClusterInput, Migration, PlanResult } from "./types.js";

interface QueueEntry {
  readonly key: string;
  readonly count: number;
  readonly mem: number;
}

function lessThan(a: QueueEntry, b: QueueEntry): boolean {
  return a.count !== b.count ? a.count < b.count : a.mem < b.mem;
}

/** Binary min-heap ordered lexicographically by (count, mem). */
class MinHeap {
  private items: QueueEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(entry: QueueEntry): void {
    const items = this.items;
    items.push(entry);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!lessThan(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  pop(): QueueEntry | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && lessThan(items[left], items[smallest])) smallest = left;
        if (right < items.length && lessThan(items[right], items[smallest])) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

interface ParentInfo {
  readonly prevKey: string;
  readonly migration: Migration;
}

/**
 * Compute an optimal evacuation plan for the maintenance host.
 *
 * Optimal = fewest migrations, then least total migrated memory (MiB).
 * Uniform-cost search over placement states with lexicographic costs;
 * the state space is finite, so the search always terminates, and
 * { ok: false } is returned only after every reachable state was
 * exhausted, i.e. no executable plan exists.
 */
export function planEvacuation(input: ClusterInput): PlanResult {
  const hostIndexById = new Map<string, number>();
  input.hosts.forEach((host, i) => {
    if (hostIndexById.has(host.id)) throw new Error(`duplicate host id: ${host.id}`);
    hostIndexById.set(host.id, i);
  });
  const maintenanceIdx = hostIndexById.get(input.maintenanceHostId);
  if (maintenanceIdx === undefined) {
    throw new Error(`unknown maintenance host: ${input.maintenanceHostId}`);
  }

  const vmIndexById = new Map<string, number>();
  input.vms.forEach((vm, i) => {
    if (vmIndexById.has(vm.id)) throw new Error(`duplicate vm id: ${vm.id}`);
    vmIndexById.set(vm.id, i);
  });

  const vmCount = input.vms.length;
  const hostCount = input.hosts.length;
  const startPlacement = new Array<number>(vmCount);
  for (let i = 0; i < vmCount; i++) {
    const hostId = input.placement[input.vms[i].id];
    if (hostId === undefined) throw new Error(`vm ${input.vms[i].id} has no placement`);
    const idx = hostIndexById.get(hostId);
    if (idx === undefined) throw new Error(`vm ${input.vms[i].id} placed on unknown host ${hostId}`);
    startPlacement[i] = idx;
  }

  // Candidate target hosts per VM: same architecture, never the maintenance host.
  const candidates: number[][] = input.vms.map((vm) => {
    const list: number[] = [];
    for (let h = 0; h < hostCount; h++) {
      if (h !== maintenanceIdx && input.hosts[h].arch === vm.arch) list.push(h);
    }
    return list;
  });

  const encode = (placement: readonly number[]): string => placement.join(",");
  const isGoal = (placement: readonly number[]): boolean => {
    for (let i = 0; i < vmCount; i++) if (placement[i] === maintenanceIdx) return false;
    return true;
  };

  const startKey = encode(startPlacement);
  const best = new Map<string, QueueEntry>([[startKey, { key: startKey, count: 0, mem: 0 }]]);
  const parents = new Map<string, ParentInfo>();
  const states = new Map<string, number[]>([[startKey, startPlacement]]);
  const heap = new MinHeap();
  heap.push({ key: startKey, count: 0, mem: 0 });

  let goalKey: string | undefined;
  let goalCost: QueueEntry | undefined;

  while (heap.size > 0) {
    const current = heap.pop()!;
    const recorded = best.get(current.key);
    if (!recorded || recorded.count !== current.count || recorded.mem !== current.mem) continue;

    const placement = states.get(current.key)!;
    if (isGoal(placement)) {
      goalKey = current.key;
      goalCost = current;
      break;
    }

    const cpuUsed = new Array<number>(hostCount).fill(0);
    const memUsed = new Array<number>(hostCount).fill(0);
    for (let i = 0; i < vmCount; i++) {
      cpuUsed[placement[i]] += input.vms[i].cpu;
      memUsed[placement[i]] += input.vms[i].mem;
    }

    for (let i = 0; i < vmCount; i++) {
      const vm = input.vms[i];
      const from = placement[i];
      for (const to of candidates[i]) {
        if (to === from) continue;
        if (cpuUsed[to] + vm.cpu > input.hosts[to].cpuBudget) continue;
        if (memUsed[to] + vm.mem > input.hosts[to].memBudget) continue;

        const next = placement.slice();
        next[i] = to;
        const nextKey = encode(next);
        const nextCost: QueueEntry = {
          key: nextKey,
          count: current.count + 1,
          mem: current.mem + vm.mem,
        };
        const seen = best.get(nextKey);
        if (seen && (seen.count < nextCost.count ||
            (seen.count === nextCost.count && seen.mem <= nextCost.mem))) {
          continue;
        }
        best.set(nextKey, nextCost);
        states.set(nextKey, next);
        parents.set(nextKey, {
          prevKey: current.key,
          migration: {
            vmId: vm.id,
            fromHostId: input.hosts[from].id,
            toHostId: input.hosts[to].id,
          },
        });
        heap.push(nextCost);
      }
    }
  }

  if (goalKey === undefined || goalCost === undefined) {
    return {
      ok: false,
      reason: "no executable evacuation plan exists for the maintenance host",
    };
  }

  const migrations: Migration[] = [];
  for (let key = goalKey; key !== startKey;) {
    const parent = parents.get(key)!;
    migrations.push(parent.migration);
    key = parent.prevKey;
  }
  migrations.reverse();

  return {
    ok: true,
    plan: {
      migrations,
      migrationCount: goalCost.count,
      totalMigratedMem: goalCost.mem,
    },
  };
}
