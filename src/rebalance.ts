import { RebalanceInput, RebalanceResult } from "./types";
import { minCostMaxFlow } from "./solver";

/**
 * Recompute device -> license pool bindings for one software product.
 * Maximizes covered devices first, then preserved previous bindings.
 *
 * Modelled as min-cost max-flow:
 *   source -> device (cap 1, cost 0)
 *   device -> pool   (cap 1, cost 0 when it keeps the previous binding, else 1)
 *   pool   -> sink   (cap totalSeats, cost 0)
 * Max flow maximizes coverage; min cost then maximizes preserved bindings.
 */
export function rebalance(input: RebalanceInput): RebalanceResult {
  const { businessDate, devices } = input;

  // Pools expired before the business date cannot serve seats;
  // a pool is still valid on its expiry day.
  const pools = input.pools.filter((p) => p.expiresAt >= businessDate && p.totalSeats > 0);

  const source = 0;
  const deviceBase = 1;
  const poolBase = deviceBase + devices.length;
  const sink = poolBase + pools.length;

  const edges: Array<{ from: number; to: number; capacity: number; cost: number }> = [];
  const devicePoolEdges: Array<{ deviceIndex: number; poolIndex: number; edgeIndex: number }> = [];

  devices.forEach((device, deviceIndex) => {
    edges.push({ from: source, to: deviceBase + deviceIndex, capacity: 1, cost: 0 });
  });

  devices.forEach((device, deviceIndex) => {
    pools.forEach((pool, poolIndex) => {
      if (!pool.allowedDepartments.includes(device.department)) return;
      const cost = device.previousPoolId === pool.id ? 0 : 1;
      devicePoolEdges.push({ deviceIndex, poolIndex, edgeIndex: edges.length });
      edges.push({ from: deviceBase + deviceIndex, to: poolBase + poolIndex, capacity: 1, cost });
    });
  });

  pools.forEach((pool, poolIndex) => {
    edges.push({ from: poolBase + poolIndex, to: sink, capacity: pool.totalSeats, cost: 0 });
  });

  const { edgeFlows } = minCostMaxFlow(sink + 1, source, sink, edges);

  const assignments: Array<{ deviceId: string; poolId: string }> = [];
  const covered = new Array<boolean>(devices.length).fill(false);
  for (const { deviceIndex, poolIndex, edgeIndex } of devicePoolEdges) {
    if (edgeFlows[edgeIndex] > 0) {
      assignments.push({ deviceId: devices[deviceIndex].id, poolId: pools[poolIndex].id });
      covered[deviceIndex] = true;
    }
  }

  const uncoveredDeviceIds = devices.filter((_, i) => !covered[i]).map((d) => d.id);
  return { assignments, uncoveredDeviceIds };
}
