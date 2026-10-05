import type {
  EvacuationRequest,
  EvacuationResult,
  Migration,
} from "./types.js";

/**
 * Optimal evacuation planner.
 *
 * Searches the space of VM placements with Dijkstra's algorithm over the
 * lexicographic cost (migration count, total migrated memory MiB):
 * every migration costs (1, vmMemoryMib), so the first goal state popped
 * from the priority queue is optimal for both objectives, in that order.
 *
 * A state is the host index of every VM. A transition moves one VM to a
 * different host of the same architecture that has enough remaining CPU
 * and memory at the moment the migration starts. The maintenance host
 * never accepts incoming migrations. The search is complete: it only
 * reports "no-solution" after the entire reachable state space is
 * exhausted, never on a heuristic failure.
 */
export function planEvacuation(request: EvacuationRequest): EvacuationResult {
  const { hosts, vms, maintenanceHostId } = request;

  const hostIndexById = new Map<string, number>();
  hosts.forEach((host, index) => hostIndexById.set(host.id, index));
  const vmIndexById = new Map<string, number>();
  vms.forEach((vm, index) => vmIndexById.set(vm.id, index));

  const maintenanceIndex = hostIndexById.get(maintenanceHostId);
  if (maintenanceIndex === undefined) {
    throw new Error(`unknown maintenance host: ${maintenanceHostId}`);
  }

  const hostCount = hosts.length;
  const vmCount = vms.length;

  // Initial placement as host indices, in VM order.
  const initialPlacement = new Array<number>(vmCount);
  for (let vmIndex = 0; vmIndex < vmCount; vmIndex++) {
    const hostId = request.placement[vms[vmIndex]!.id];
    const hostIndex = hostId === undefined ? undefined : hostIndexById.get(hostId);
    if (hostIndex === undefined) {
      throw new Error(`VM ${vms[vmIndex]!.id} has no valid placement`);
    }
    initialPlacement[vmIndex] = hostIndex;
  }

  const encode = (placement: number[]): string => placement.join(",");

  const isGoal = (placement: number[]): boolean => {
    for (let vmIndex = 0; vmIndex < vmCount; vmIndex++) {
      if (placement[vmIndex] === maintenanceIndex) return false;
    }
    return true;
  };

  // Per-host used resources for a placement, computed incrementally by callers.
  const computeUsage = (placement: number[]): { cpu: number[]; mem: number[] } => {
    const cpu = new Array<number>(hostCount).fill(0);
    const mem = new Array<number>(hostCount).fill(0);
    for (let vmIndex = 0; vmIndex < vmCount; vmIndex++) {
      const hostIndex = placement[vmIndex]!;
      cpu[hostIndex]! += vms[vmIndex]!.cpu;
      mem[hostIndex]! += vms[vmIndex]!.memoryMib;
    }
    return { cpu, mem };
  };

  interface Node {
    placement: number[];
    moves: number;
    memory: number;
  }

  // Binary min-heap ordered by (moves, memory) lexicographically.
  const heap: Node[] = [];
  const less = (a: Node, b: Node): boolean =>
    a.moves < b.moves || (a.moves === b.moves && a.memory < b.memory);
  const push = (node: Node): void => {
    heap.push(node);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (!less(heap[child]!, heap[parent]!)) break;
      [heap[child], heap[parent]] = [heap[parent]!, heap[child]!];
      child = parent;
    }
  };
  const pop = (): Node | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < heap.length && less(heap[left]!, heap[smallest]!)) smallest = left;
        if (right < heap.length && less(heap[right]!, heap[smallest]!)) smallest = right;
        if (smallest === parent) break;
        [heap[parent], heap[smallest]] = [heap[smallest]!, heap[parent]!];
        parent = smallest;
      }
    }
    return top;
  };

  // Best known cost per visited state; a state is finalized when popped.
  const bestCost = new Map<string, { moves: number; memory: number }>();
  const parent = new Map<string, { key: string; vmIndex: number; fromHost: number }>();

  const startKey = encode(initialPlacement);
  bestCost.set(startKey, { moves: 0, memory: 0 });
  push({ placement: initialPlacement, moves: 0, memory: 0 });

  let goalNode: Node | undefined;
  let goalKey: string | undefined;

  while (heap.length > 0) {
    const node = pop()!;
    const key = encode(node.placement);
    const best = bestCost.get(key);
    if (best === undefined || node.moves !== best.moves || node.memory !== best.memory) {
      continue; // stale heap entry
    }
    if (isGoal(node.placement)) {
      goalNode = node;
      goalKey = key;
      break;
    }

    const usage = computeUsage(node.placement);
    for (let vmIndex = 0; vmIndex < vmCount; vmIndex++) {
      const vm = vms[vmIndex]!;
      const fromHost = node.placement[vmIndex]!;
      for (let toHost = 0; toHost < hostCount; toHost++) {
        if (toHost === fromHost || toHost === maintenanceIndex) continue;
        const host = hosts[toHost]!;
        if (host.arch !== vm.arch) continue;
        if (usage.cpu[toHost]! + vm.cpu > host.cpuBudget) continue;
        if (usage.mem[toHost]! + vm.memoryMib > host.memoryBudgetMib) continue;

        const nextPlacement = node.placement.slice();
        nextPlacement[vmIndex] = toHost;
        const nextKey = encode(nextPlacement);
        const nextMoves = node.moves + 1;
        const nextMemory = node.memory + vm.memoryMib;
        const known = bestCost.get(nextKey);
        if (
          known !== undefined &&
          (known.moves < nextMoves ||
            (known.moves === nextMoves && known.memory <= nextMemory))
        ) {
          continue;
        }
        bestCost.set(nextKey, { moves: nextMoves, memory: nextMemory });
        parent.set(nextKey, { key, vmIndex, fromHost });
        push({ placement: nextPlacement, moves: nextMoves, memory: nextMemory });
      }
    }
  }

  if (goalNode === undefined || goalKey === undefined) {
    return { status: "no-solution" };
  }

  // Reconstruct migrations from the goal back to the start.
  const migrations: Migration[] = [];
  let cursor = goalKey;
  while (cursor !== startKey) {
    const step = parent.get(cursor)!;
    const vm = vms[step.vmIndex]!;
    const toHostIndex = Number(cursor.split(",")[step.vmIndex]!);
    migrations.push({
      vmId: vm.id,
      fromHostId: hosts[step.fromHost]!.id,
      toHostId: hosts[toHostIndex]!.id,
    });
    cursor = step.key;
  }
  migrations.reverse();

  return {
    status: "planned",
    plan: { migrations, totalMigratedMemoryMib: goalNode.memory },
  };
}
