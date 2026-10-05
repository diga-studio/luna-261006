import type { AttackPath, Connection, PathAnalyzer, Protocol, Topology } from "./types.js";

const PROTOCOL_WEIGHTS: Record<Protocol, number> = {
  "Modbus TCP": 6,
  DNP3: 4,
  "OPC-UA": 1,
};

const ZONE_CROSSING_SCORE = 8;
const CRITICALITY_FACTOR = 10;
const MAX_HOPS = 12;
const TOP_N = 10;

interface Arc {
  connectionId: number;
  nextAsset: number;
  weight: number;
}

function compareConnectionIds(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function comparePaths(a: AttackPath, b: AttackPath): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.connectionIds.length !== b.connectionIds.length) {
    return a.connectionIds.length - b.connectionIds.length;
  }
  return compareConnectionIds(a.connectionIds, b.connectionIds);
}

function buildAdjacency(topology: Topology): Map<number, Arc[]> {
  const levelById = new Map<number, number>();
  for (const asset of topology.assets) {
    levelById.set(asset.id, asset.level);
  }
  const adjacency = new Map<number, Arc[]>();
  const addArc = (from: number, connection: Connection, next: number): void => {
    const fromLevel = levelById.get(from);
    const nextLevel = levelById.get(next);
    if (fromLevel === undefined || nextLevel === undefined) return;
    const crossing = fromLevel === nextLevel ? 0 : ZONE_CROSSING_SCORE;
    const arc: Arc = {
      connectionId: connection.id,
      nextAsset: next,
      weight: PROTOCOL_WEIGHTS[connection.protocol] + crossing,
    };
    const arcs = adjacency.get(from);
    if (arcs === undefined) {
      adjacency.set(from, [arc]);
    } else {
      arcs.push(arc);
    }
  };
  for (const connection of topology.connections) {
    addArc(connection.from, connection, connection.to);
    if (connection.bidirectional) {
      addArc(connection.to, connection, connection.from);
    }
  }
  return adjacency;
}

/** 深度优先枚举所有不超过 MAX_HOPS 条连接、不重复资产的简单路径 */
function enumeratePaths(
  adjacency: Map<number, Arc[]>,
  entryId: number,
  targetId: number,
  targetBonus: number,
): AttackPath[] {
  const results: AttackPath[] = [];
  const visited = new Set<number>([entryId]);
  const connectionIds: number[] = [];
  const assetIds: number[] = [entryId];

  const dfs = (current: number, score: number): void => {
    if (connectionIds.length >= MAX_HOPS) return;
    const arcs = adjacency.get(current);
    if (arcs === undefined) return;
    for (const arc of arcs) {
      if (visited.has(arc.nextAsset)) continue;
      connectionIds.push(arc.connectionId);
      assetIds.push(arc.nextAsset);
      const nextScore = score + arc.weight;
      if (arc.nextAsset === targetId) {
        results.push({
          connectionIds: [...connectionIds],
          assetIds: [...assetIds],
          score: nextScore + targetBonus,
        });
      } else {
        visited.add(arc.nextAsset);
        dfs(arc.nextAsset, nextScore);
        visited.delete(arc.nextAsset);
      }
      connectionIds.pop();
      assetIds.pop();
    }
  };

  dfs(entryId, 0);
  return results;
}

/** 基于完整拓扑创建路径分析器 */
export function createAnalyzer(topology: Topology): PathAnalyzer {
  const adjacency = buildAdjacency(topology);
  const criticalityById = new Map<number, number>();
  for (const asset of topology.assets) {
    criticalityById.set(asset.id, asset.criticality);
  }

  return {
    findTopPaths(entryId: number, targetId: number): AttackPath[] {
      if (entryId === targetId) return [];
      const criticality = criticalityById.get(targetId);
      if (criticality === undefined || !criticalityById.has(entryId)) return [];
      const paths = enumeratePaths(
        adjacency,
        entryId,
        targetId,
        criticality * CRITICALITY_FACTOR,
      );
      paths.sort(comparePaths);
      return paths.slice(0, TOP_N);
    },
  };
}
