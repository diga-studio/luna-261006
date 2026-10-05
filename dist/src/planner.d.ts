import type { EvacuationRequest, EvacuationResult } from "./types.js";
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
export declare function planEvacuation(request: EvacuationRequest): EvacuationResult;
