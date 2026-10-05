"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findTopAttackPaths = void 0;
const types_1 = require("./types");
__exportStar(require("./types"), exports);
const PROTOCOL_WEIGHT = {
    [types_1.Protocol.ModbusTcp]: 6,
    [types_1.Protocol.DNP3]: 4,
    [types_1.Protocol.OpcUa]: 1,
};
const ZONE_CROSSING_SCORE = 8;
const MAX_CONNECTIONS = 12;
const MAX_RESULTS = 10;
function comparePaths(a, b) {
    if (a.score !== b.score)
        return b.score - a.score;
    if (a.connectionIds.length !== b.connectionIds.length) {
        return a.connectionIds.length - b.connectionIds.length;
    }
    for (let i = 0; i < a.connectionIds.length; i++) {
        if (a.connectionIds[i] !== b.connectionIds[i]) {
            return a.connectionIds[i] - b.connectionIds[i];
        }
    }
    return 0;
}
/**
 * 查询从入口资产到目标资产的前十条最高风险攻击路径。
 * 排序：分数降序；同分按连接数升序；再相同按连接编号序列数字字典序升序。
 */
function findTopAttackPaths(topology, entryId, targetId) {
    if (entryId === targetId)
        return [];
    const purdueLevelById = new Map();
    let targetCriticality;
    for (const asset of topology.assets) {
        purdueLevelById.set(asset.id, asset.purdueLevel);
        if (asset.id === targetId)
            targetCriticality = asset.criticality;
    }
    if (targetCriticality === undefined || !purdueLevelById.has(entryId)) {
        return [];
    }
    const criticalityBonus = targetCriticality * 10;
    const adjacency = new Map();
    const addEdge = (from, edge) => {
        const edges = adjacency.get(from);
        if (edges)
            edges.push(edge);
        else
            adjacency.set(from, [edge]);
    };
    for (const connection of topology.connections) {
        if (!purdueLevelById.has(connection.from) ||
            !purdueLevelById.has(connection.to)) {
            continue;
        }
        addEdge(connection.from, { connection, next: connection.to });
        if (connection.bidirectional) {
            addEdge(connection.to, { connection, next: connection.from });
        }
    }
    const results = [];
    const visited = new Set([entryId]);
    const pathConnectionIds = [];
    let pathScore = 0;
    const dfs = (current) => {
        if (pathConnectionIds.length >= MAX_CONNECTIONS)
            return;
        const currentLevel = purdueLevelById.get(current);
        for (const edge of adjacency.get(current) ?? []) {
            const { connection, next } = edge;
            const crossing = currentLevel !== purdueLevelById.get(next) ? ZONE_CROSSING_SCORE : 0;
            const edgeScore = PROTOCOL_WEIGHT[connection.protocol] + crossing;
            if (next === targetId) {
                results.push({
                    connectionIds: [...pathConnectionIds, connection.id],
                    score: pathScore + edgeScore + criticalityBonus,
                });
                continue;
            }
            if (visited.has(next))
                continue;
            visited.add(next);
            pathConnectionIds.push(connection.id);
            pathScore += edgeScore;
            dfs(next);
            pathScore -= edgeScore;
            pathConnectionIds.pop();
            visited.delete(next);
        }
    };
    dfs(entryId);
    results.sort(comparePaths);
    return results.slice(0, MAX_RESULTS);
}
exports.findTopAttackPaths = findTopAttackPaths;
